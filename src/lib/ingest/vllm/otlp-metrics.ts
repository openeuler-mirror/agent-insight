// Path C：OTel Collector（prometheus receiver 抓 vLLM）→ OTLP/JSON 推到本服务 →
// 归一到与 Path A 完全相同的 InfraMetricSample。算法在 spike 04 上验证 A≡C 数值一致。

import {
  Histogram,
  InfraMetricSample,
  VLLM_COUNTERS,
  VLLM_GAUGES,
  VLLM_HISTOGRAMS,
} from '@/lib/infra/types';

// 只覆盖本归一化用到的 OTLP/JSON 字段（不是完整 OTLP schema）。
interface OtlpAnyValue {
  stringValue?: string;
  asString?: string;
  intValue?: number | string;
  doubleValue?: number;
}

/** AnyValue → 字符串（兼容 string/int/double；protobuf 解码出来的 port 可能是 int）。 */
function anyValueStr(v: OtlpAnyValue | undefined): string {
  if (v == null) return '';
  if (v.stringValue != null) return v.stringValue;
  if (v.asString != null) return v.asString;
  if (v.intValue != null) return String(v.intValue);
  if (v.doubleValue != null) return String(v.doubleValue);
  return '';
}
interface OtlpKeyValue {
  key: string;
  value?: OtlpAnyValue;
}
interface OtlpDataPoint {
  attributes?: OtlpKeyValue[];
  asDouble?: number;
  asInt?: number | string;
  sum?: number;
  count?: number | string;
  bucketCounts?: Array<number | string>;
  explicitBounds?: number[];
}
interface OtlpMetric {
  name: string;
  gauge?: { dataPoints?: OtlpDataPoint[] };
  sum?: { dataPoints?: OtlpDataPoint[] };
  histogram?: { dataPoints?: OtlpDataPoint[] };
}
interface OtlpScopeMetrics {
  metrics?: OtlpMetric[];
}
interface OtlpResource {
  attributes?: OtlpKeyValue[];
}
interface OtlpResourceMetrics {
  resource?: OtlpResource;
  scopeMetrics?: OtlpScopeMetrics[];
}
export interface OtlpMetricsPayload {
  resourceMetrics?: OtlpResourceMetrics[];
}

/** 从 OTLP resource attributes 还原 vLLM 源地址（prometheus receiver 会带 server.address/port/url.scheme）。 */
export function endpointFromResource(rm: OtlpResourceMetrics): string | null {
  const a: Record<string, string> = {};
  for (const kv of rm.resource?.attributes ?? []) {
    const v = anyValueStr(kv.value);
    if (v) a[kv.key] = v;
  }
  const scheme = a['url.scheme'] || 'http';
  if (a['server.address'] && a['server.port']) return `${scheme}://${a['server.address']}:${a['server.port']}`;
  if (a['service.instance.id']?.includes(':')) return `${scheme}://${a['service.instance.id']}`;
  return null;
}

const GAUGE_SET: ReadonlySet<string> = new Set(VLLM_GAUGES);
const COUNTER_SET: ReadonlySet<string> = new Set(VLLM_COUNTERS);
const HIST_SET: ReadonlySet<string> = new Set(VLLM_HISTOGRAMS);

// OTLP 把指标名里的 ':' 换成 '_'；不同 collector 配置可能保留 'vllm:' 冒号名。
// 两种都收敛回我们的规范冒号名；counter 的 '_total' 被 receiver 截掉时补回。
function canonicalize(otlpName: string): string {
  const colon = otlpName.replace(/^vllm_/, 'vllm:');
  if (GAUGE_SET.has(colon) || COUNTER_SET.has(colon) || HIST_SET.has(colon)) return colon;
  if (COUNTER_SET.has(`${colon}_total`)) return `${colon}_total`;
  return colon;
}

function num(dp: OtlpDataPoint): number {
  if (dp.asDouble != null) return dp.asDouble;
  if (dp.asInt != null) return Number(dp.asInt);
  return 0;
}

function labelsOf(dp: OtlpDataPoint): Record<string, string> {
  const o: Record<string, string> = {};
  for (const a of dp.attributes ?? []) o[a.key] = anyValueStr(a.value);
  return o;
}

export interface OtlpNormalizeOptions {
  source?: string;
  target?: string;
  tsMs?: number;
}

/** OTLP/JSON metrics → InfraMetricSample（与 prom-text.normalize 同形）。 */
export function normalizeOtlpMetrics(
  otlp: OtlpMetricsPayload,
  opts: OtlpNormalizeOptions = {},
): InfraMetricSample {
  const { source = 'vllm-otlp-push', tsMs = Date.now() } = opts;

  let model: string | null = null;
  let resolvedTarget = opts.target ?? '';
  const gauges: Record<string, number> = {};
  const counters: Record<string, number> = {};
  const histograms: Record<string, Histogram> = {};
  const waitingByReason: Record<string, number> = {};

  for (const rm of otlp.resourceMetrics ?? []) {
    if (!resolvedTarget) resolvedTarget = endpointFromResource(rm) ?? '';
    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const name = canonicalize(m.name);
        const dps = m.gauge?.dataPoints ?? m.sum?.dataPoints ?? m.histogram?.dataPoints ?? [];
        for (const dp of dps) {
          const lab = labelsOf(dp);
          if (lab.model_name) model = lab.model_name;

          if (m.histogram && HIST_SET.has(name)) {
            const bounds = dp.explicitBounds ?? [];
            const bucketCounts = (dp.bucketCounts ?? []).map(Number);
            // OTLP bucketCounts 是每桶计数 → 转成 Prometheus 风格累计 {le,count}
            let cum = 0;
            const buckets = bucketCounts.map((c, i) => {
              cum += c;
              return { le: i < bounds.length ? bounds[i] : Infinity, count: cum };
            });
            histograms[name] = { buckets, sum: Number(dp.sum ?? 0), count: Number(dp.count ?? cum) };
          } else if (GAUGE_SET.has(name)) {
            gauges[name] = num(dp);
          } else if (name === 'vllm:num_requests_waiting_by_reason' || m.name.includes('waiting_by_reason')) {
            waitingByReason[lab.reason] = num(dp);
          } else if (COUNTER_SET.has(name)) {
            counters[name] = num(dp);
          }
        }
      }
    }
  }

  return { tsMs, source, target: resolvedTarget || 'otel-collector', model, gauges, counters, histograms, waitingByReason };
}
