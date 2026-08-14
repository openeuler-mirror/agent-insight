import otlpRoot from '@opentelemetry/otlp-transformer/build/src/generated/root';

export type OtlpSignal = 'traces';

export type DecodedOtlpRequest = {
  body: any;
  rawBody: Uint8Array;
  contentType: string;
  encoding: 'json' | 'protobuf';
};

export class OtlpDecodeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'OtlpDecodeError';
    this.status = status;
  }
}

const toObjectOptions = {
  longs: String,
  enums: String,
  bytes: Array,
  defaults: false,
  arrays: true,
  objects: true,
};

const traceRequestType = (otlpRoot as any).opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest;

function isJsonContentType(contentType: string): boolean {
  return contentType.toLowerCase().includes('application/json');
}

function isProtobufContentType(contentType: string): boolean {
  const value = contentType.toLowerCase();
  return value.includes('application/x-protobuf') || value.includes('application/protobuf');
}

function bytesToHex(value: any): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return Buffer.from(value).toString('hex');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return undefined;
}

function normalizeSpanIdentityBytes(span: any): void {
  if (!span || typeof span !== 'object') return;
  for (const key of ['traceId', 'spanId', 'parentSpanId']) {
    const hex = bytesToHex(span[key]);
    if (hex !== undefined) span[key] = hex;
  }

  for (const link of Array.isArray(span.links) ? span.links : []) {
    const traceId = bytesToHex(link?.traceId);
    const spanId = bytesToHex(link?.spanId);
    if (traceId !== undefined) link.traceId = traceId;
    if (spanId !== undefined) link.spanId = spanId;
  }
}

function normalizeTraceRequestObject(body: any): any {
  for (const resourceSpan of Array.isArray(body?.resourceSpans) ? body.resourceSpans : []) {
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : [];
    for (const scopeSpan of scopeSpans) {
      for (const span of Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : []) {
        normalizeSpanIdentityBytes(span);
      }
    }
  }
  return body;
}

export function decodeOtlpProtobufBody(data: Uint8Array, signal: OtlpSignal): any {
  try {
    if (signal === 'traces') {
      const decoded = traceRequestType.decode(data);
      const body = traceRequestType.toObject(decoded, toObjectOptions);
      return normalizeTraceRequestObject(body);
    }
  } catch (err: any) {
    throw new OtlpDecodeError(400, `Invalid OTLP ${signal} protobuf payload: ${err?.message || 'decode failed'}`);
  }

  throw new OtlpDecodeError(415, `OTLP ${signal} protobuf is not supported`);
}

export async function decodeOtlpRequestWithRaw(
  req: Request,
  signal: OtlpSignal,
): Promise<DecodedOtlpRequest> {
  const contentType = req.headers.get('content-type') || '';
  const rawBody = new Uint8Array(await req.arrayBuffer());

  if (isJsonContentType(contentType)) {
    try {
      return {
        body: JSON.parse(Buffer.from(rawBody).toString('utf8')),
        rawBody,
        contentType,
        encoding: 'json',
      };
    } catch (err: any) {
      throw new OtlpDecodeError(400, `Invalid OTLP ${signal} JSON payload: ${err?.message || 'parse failed'}`);
    }
  }

  if (isProtobufContentType(contentType)) {
    return {
      body: decodeOtlpProtobufBody(rawBody, signal),
      rawBody,
      contentType,
      encoding: 'protobuf',
    };
  }

  throw new OtlpDecodeError(
    415,
    `Unsupported OTLP ${signal} content type: ${contentType || '<missing>'}. Use application/json or application/x-protobuf.`,
  );
}

export async function decodeOtlpRequest(req: Request, signal: OtlpSignal): Promise<any> {
  return (await decodeOtlpRequestWithRaw(req, signal)).body;
}
