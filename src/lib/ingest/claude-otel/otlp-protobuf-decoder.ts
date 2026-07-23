/**
 * OTLP http/protobuf 解码器
 *
 * 职责：将 application/x-protobuf 的 ExportTraceServiceRequest 安全解码并归一为
 * 与 OTLP/JSON (application/json) 同构的纯对象，使下游 normalizeClaudeOtlpTraces
 * 零分叉地处理两种编码的上报。
 *
 * 核心归一：protobufjs 默认将 bytes 字段输出为 base64 字符串，而 OTLP/JSON 约定了
 * traceId/spanId/parentSpanId 为 lowercase hex 字符串。本模块在解码后递归遍历所有
 * span 层级的 bytes 字段，将其转为 hex，确保与 JSON 路径的产物字段级等价。
 *
 * 选型决策：优先复用 @opentelemetry/sdk-node 依赖树内已含的 protobufjs root
 * （@opentelemetry/otlp-transformer/build/src/generated/root），避免新增直接依赖
 * 与版本漂移。
 */

// OTEL 协议默认限制
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB
const DEFAULT_MAX_SPANS = 500;

export interface DecodeLimits {
  maxBytes?: number;
  maxSpans?: number;
}

export interface DecodeResult {
  /** 与 JSON.parse(jsonBody) 同构的纯对象，可直接喂给 normalizeClaudeOtlpTraces */
  body: Record<string, any>;
  /** 解码出的 span 总数 */
  spanCount: number;
}

export interface DecodeError {
  code: 'TOO_LARGE' | 'DECODE_FAILED' | 'TOO_MANY_SPANS' | 'MALFORMED';
  message: string;
  status: 400 | 413;
}

/** 判断是否为 Buffer 或 Uint8Array */
function isBufferLike(v: any): boolean {
  return Buffer.isBuffer(v) || v instanceof Uint8Array;
}

/**
 * 判断一个对象是否形如归一化后残留的 Buffer-like 对象
 * （即数字索引的 plain object，如 {0: 10, 1: 247, ...}）
 */
function isNumericIndexedObject(v: any): boolean {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  if (isBufferLike(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  // 所有键都是非负整数且值都在 0-255 范围
  return keys.every((k) => {
    const n = Number(k);
    if (!Number.isInteger(n) || n < 0) return false;
    const val = v[k];
    return typeof val === 'number' && Number.isInteger(val) && val >= 0 && val <= 255;
  });
}

/**
 * 将数字索引的朴素对象还原为 hex 字符串
 */
function numericObjectToHex(v: Record<string, number>): string {
  const keys = Object.keys(v).map(Number).sort((a, b) => a - b);
  const arr = new Uint8Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    arr[i] = v[keys[i]];
  }
  return Buffer.from(arr).toString('hex');
}

/**
 * 将 protobuf 字节流中的 bytes 字段递归转换为 lowercase hex 字符串。
 *
 * 处理两种形态：
 * 1. Buffer/Uint8Array（protobufjs decode 原始产出）
 * 2. 数字索引的朴素对象 {0: 10, 1: 247, ...}（被 normalizeAnyValue 误转后的残留）
 */
function bytesToHex(value: any): any {
  if (value === null || value === undefined) return value;

  // Buffer/Uint8Array 直接转
  if (isBufferLike(value)) {
    return Buffer.from(value).toString('hex');
  }

  // 数字索引的朴素对象 → 也当 buffer 对待
  if (isNumericIndexedObject(value)) {
    return numericObjectToHex(value);
  }

  if (Array.isArray(value)) {
    return value.map(bytesToHex);
  }

  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      (value as Record<string, any>)[k] = bytesToHex(v);
    }
    return value;
  }

  return value;
}

/**
 * 归一化 protobuf 解码后的 AnyValue 结构，使其与 JSON 路径的产物一致。
 *
 * protobufjs decode 产出的 AnyValue oneof 字段结构（如 { stringValue: 'foo' }）
 * 与 OTLP/JSON 的表示一致，无需额外转换；但 protobuf 路径中 int64 可能以 Long
 * 对象形式出现，需转为 number。
 *
 * 注意：不要触碰 Buffer/Uint8Array，保留给 bytesToHex 处理。
 */
function normalizeAnyValue(value: any): any {
  if (value === null || value === undefined) return value;

  // 不要触碰 Buffer/Uint8Array，留给 bytesToHex 处理
  if (isBufferLike(value)) return value;

  if (typeof value === 'object' && !Array.isArray(value)) {
    // protobufjs Long → number
    if (value.low !== undefined && value.high !== undefined && value.unsigned !== undefined) {
      return Number(value.toString());
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeAnyValue(v);
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeAnyValue);
  }

  return value;
}

/**
 * 将 protobufjs decode 产出的 ExportTraceServiceRequest 归一化为与
 * JSON.parse(jsonBody) 同构的纯对象。
 *
 * 归一化步骤：
 * 1. Long → number（normalizeAnyValue）
 * 2. bytes 字段 → lowercase hex（bytesToHex，后执行以捕获 normalizeAnyValue 产生的残留）
 */
function normalizeDecodedRequest(raw: any): Record<string, any> {
  // 先处理 Long→number，但不破坏 Buffer
  const normed = normalizeAnyValue(raw);
  // 再转 bytes→hex（同时处理原始 Buffer 和 normalizeAnyValue 可能遗留的残留）
  return bytesToHex(normed);
}

/**
 * 解码 application/x-protobuf 的 ExportTraceServiceRequest 字节流。
 *
 * @param rawBytes - 请求 body 原始字节
 * @param limits  - 可选限制（字节数上限、span 数上限）
 * @returns 成功返回 DecodeResult，失败返回 DecodeError
 */
export function decodeOtlpProtobuf(
  rawBytes: ArrayBuffer | Uint8Array | Buffer,
  limits: DecodeLimits = {},
): DecodeResult | DecodeError {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxSpans = limits.maxSpans ?? DEFAULT_MAX_SPANS;

  // 1. 解码前字节数上限防护
  const buf = Buffer.isBuffer(rawBytes)
    ? rawBytes
    : Buffer.from(rawBytes as ArrayBuffer);

  if (buf.length > maxBytes) {
    return {
      code: 'TOO_LARGE',
      message: `Request body exceeds ${maxBytes} bytes limit (got ${buf.length} bytes). Please reduce batch size.`,
      status: 413,
    };
  }

  // 2. 解码
  let decoded: any;
  try {
    // 延迟加载 protobuf root（避免模块初始化时加载 protobuf 依赖）
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const root = require('@opentelemetry/otlp-transformer/build/src/generated/root');
    const traceRequestType = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;
    decoded = traceRequestType.decode(buf);
  } catch (err: any) {
    return {
      code: 'DECODE_FAILED',
      message: `Failed to decode protobuf: ${err?.message || String(err)}. Ensure body is a valid ExportTraceServiceRequest in protobuf format.`,
      status: 400,
    };
  }

  // 3. 归一化（Long→number, bytes→hex）
  const body = normalizeDecodedRequest(decoded);

  // 4. 统计 span 数并做批量上限校验
  let spanCount = 0;
  try {
    const rss = Array.isArray(body.resourceSpans) ? body.resourceSpans : [];
    for (const rs of rss) {
      const sss = Array.isArray(rs.scopeSpans) ? rs.scopeSpans : [];
      for (const ss of sss) {
        const spans = Array.isArray(ss.spans) ? ss.spans : [];
        spanCount += spans.length;
      }
    }
  } catch {
    return {
      code: 'MALFORMED',
      message: 'Decoded protobuf structure is malformed: expected resourceSpans[].scopeSpans[].spans hierarchy.',
      status: 400,
    };
  }

  if (spanCount > maxSpans) {
    return {
      code: 'TOO_MANY_SPANS',
      message: `Too many spans: ${spanCount} exceeds limit of ${maxSpans}. Please reduce batch size.`,
      status: 400,
    };
  }

  return { body, spanCount };
}
