// Path A：拉 vLLM `/metrics`，解析 Prometheus exposition 文本 → 统一 InfraMetricSample。
// 算法在 .spike/infra-observability/01-scrape-parse.mjs 上用真实 GX10 数据验证过。

import {
  Histogram,
  InfraMetricSample,
  VLLM_COUNTERS,
  VLLM_GAUGES,
  VLLM_HISTOGRAMS,
  VLLM_WAITING_BY_REASON,
} from '@/lib/infra/types';

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface PromFamily {
  type: string;
  help: string;
}

export interface ParsedProm {
  families: Map<string, PromFamily>;
  samples: PromSample[];
}

const GAUGE_SET: ReadonlySet<string> = new Set(VLLM_GAUGES);
const COUNTER_SET: ReadonlySet<string> = new Set(VLLM_COUNTERS);

/** Prometheus 桶上界标签：`+Inf` → Infinity（parseFloat 对 "+Inf" 会给 NaN）。 */
function parseLe(le: string): number {
  return /^[+]?inf(inity)?$/i.test(le.trim()) ? Infinity : Number.parseFloat(le);
}

/** 解析 Prometheus 文本暴露格式 → 族元信息 + 扁平样本。 */
export function parsePromText(text: string): ParsedProm {
  const families = new Map<string, PromFamily>();
  const samples: PromSample[] = [];

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const m = line.match(/^#\s+(HELP|TYPE)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const [, kind, name, rest] = m;
      const fam = families.get(name) ?? { type: 'untyped', help: '' };
      if (kind === 'TYPE') fam.type = rest.trim();
      else fam.help = rest.trim();
      families.set(name, fam);
      continue;
    }

    // metric{labels} value [timestamp]
    const m = line.match(/^([^{\s]+)(\{[^}]*\})?\s+(.+)$/);
    if (!m) continue;
    const [, name, labelBlock, valuePart] = m;
    const value = Number.parseFloat(valuePart.trim().split(/\s+/)[0]);
    const labels: Record<string, string> = {};
    if (labelBlock) {
      const inner = labelBlock.slice(1, -1);
      for (const pair of inner.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
        const km = pair.match(/^\s*([^=]+)="(.*)"\s*$/);
        if (km) labels[km[1]] = km[2];
      }
    }
    samples.push({ name, labels, value });
  }

  return { families, samples };
}

export interface NormalizeOptions {
  source?: string;
  target?: string;
  tsMs?: number;
}

/** 解析结果 → 统一 InfraMetricSample（与 Path C 同形）。 */
export function normalize(parsed: ParsedProm, opts: NormalizeOptions = {}): InfraMetricSample {
  const { source = 'vllm-pull', target = '', tsMs = Date.now() } = opts;
  const { samples } = parsed;

  let model: string | null = null;
  const gauges: Record<string, number> = {};
  const counters: Record<string, number> = {};
  const histograms: Record<string, Histogram> = {};
  const waitingByReason: Record<string, number> = {};

  const histOf = (key: string): Histogram => (histograms[key] ??= { buckets: [], sum: 0, count: 0 });

  for (const s of samples) {
    if (s.labels.model_name) model = s.labels.model_name;

    if (GAUGE_SET.has(s.name)) {
      gauges[s.name] = s.value;
    } else if (COUNTER_SET.has(s.name)) {
      counters[s.name] = s.value;
    } else if (s.name === VLLM_WAITING_BY_REASON) {
      waitingByReason[s.labels.reason] = s.value;
    } else {
      for (const h of VLLM_HISTOGRAMS) {
        if (s.name === `${h}_bucket`) {
          histOf(h).buckets.push({ le: parseLe(s.labels.le), count: s.value });
        } else if (s.name === `${h}_sum`) {
          histOf(h).sum = s.value;
        } else if (s.name === `${h}_count`) {
          histOf(h).count = s.value;
        }
      }
    }
  }

  for (const h of Object.values(histograms)) h.buckets.sort((a, b) => a.le - b.le);
  return { tsMs, source, target, model, gauges, counters, histograms, waitingByReason };
}

interface ModelBucket {
  gauges: Record<string, number>;
  counters: Record<string, number>;
  histograms: Record<string, Histogram>;
  waitingByReason: Record<string, number>;
}

/**
 * 按 `model_name` 标签拆分：一个 /metrics 里若有多个模型，产出每模型一条 InfraMetricSample。
 * 单模型部署退化为长度 1 的数组（与 normalize 同形）。
 */
export function normalizeByModel(parsed: ParsedProm, opts: NormalizeOptions = {}): InfraMetricSample[] {
  const { source = 'vllm-pull', target = '', tsMs = Date.now() } = opts;
  const byModel = new Map<string, ModelBucket>();
  const bucketOf = (model: string): ModelBucket => {
    let b = byModel.get(model);
    if (!b) {
      b = { gauges: {}, counters: {}, histograms: {}, waitingByReason: {} };
      byModel.set(model, b);
    }
    return b;
  };

  for (const s of parsed.samples) {
    const model = s.labels.model_name;
    if (!model) continue; // vLLM 指标都带 model_name；无标签的进程级指标忽略
    const b = bucketOf(model);
    const histOf = (key: string): Histogram => (b.histograms[key] ??= { buckets: [], sum: 0, count: 0 });

    if (GAUGE_SET.has(s.name)) {
      b.gauges[s.name] = s.value;
    } else if (COUNTER_SET.has(s.name)) {
      b.counters[s.name] = s.value;
    } else if (s.name === VLLM_WAITING_BY_REASON) {
      b.waitingByReason[s.labels.reason] = s.value;
    } else {
      for (const h of VLLM_HISTOGRAMS) {
        if (s.name === `${h}_bucket`) histOf(h).buckets.push({ le: parseLe(s.labels.le), count: s.value });
        else if (s.name === `${h}_sum`) histOf(h).sum = s.value;
        else if (s.name === `${h}_count`) histOf(h).count = s.value;
      }
    }
  }

  return [...byModel.entries()].map(([model, b]) => {
    for (const h of Object.values(b.histograms)) h.buckets.sort((x, y) => x.le - y.le);
    return { tsMs, source, target, model, ...b };
  });
}

/** 累计桶上的 histogram_quantile（桶内线性插值）。 */
export function histQuantile(hist: Histogram | undefined, q: number): number | null {
  if (!hist || !hist.count) return null;
  const target = q * hist.count;
  let prevLe = 0;
  let prevCount = 0;
  for (const b of hist.buckets) {
    if (b.count >= target) {
      if (b.le === Infinity) return prevLe; // +Inf 桶：回退到最后一个有限边界
      const frac = (target - prevCount) / (b.count - prevCount || 1);
      return prevLe + (b.le - prevLe) * frac;
    }
    prevLe = b.le;
    prevCount = b.count;
  }
  return prevLe;
}

/** histogram 均值 = sum/count。 */
export function histAvg(hist: Histogram | undefined): number | null {
  return hist && hist.count ? hist.sum / hist.count : null;
}
