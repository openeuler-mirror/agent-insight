// 把一串 InfraMetricSample 压成适合画时序图的点序列，覆盖 8 大类信号：
// 调度/队列 · KV · 缓存复用 · 吞吐 · 延迟分段(直方图分位) · 异常(抢占)。
// counter 类（吞吐、抢占）用相邻差分算 rate；直方图取 p95。

import { histQuantile } from '@/lib/ingest/vllm/prom-text';
import type { Histogram, InfraMetricSample } from '@/lib/infra/types';

// vLLM 延迟直方图是累计的（服务启动至今所有请求）。直接对累计取分位 = 历史全量分位，几乎不动。
// 取相邻样本的桶差分 → 得到「该窗口内完成的请求」的分布，再算分位才反映当前延迟。
// 窗口内无新完成（delta count<=0）或无前序样本 → 返回 undefined（该点留空，不显示陈旧值）。
export function deltaHist(cur: Histogram | undefined, prev: Histogram | undefined): Histogram | undefined {
  if (!cur) return undefined;
  if (!prev) return undefined;
  const dCount = cur.count - prev.count;
  if (dCount <= 0) return undefined;
  const prevByLe = new Map(prev.buckets.map((b) => [b.le, b.count]));
  const buckets = cur.buckets.map((b) => ({ le: b.le, count: Math.max(0, b.count - (prevByLe.get(b.le) ?? 0)) }));
  return { buckets, sum: cur.sum - prev.sum, count: dCount };
}

export interface HistoryPoint {
  tsMs: number;
  // 调度 / 队列
  running: number;
  waiting: number;
  waitingCapacity: number;
  waitingDeferred: number;
  // KV / 显存
  kvPerc: number;
  // 缓存复用
  prefixHitPerc: number | null;
  // 吞吐
  genTokPerS: number;
  promptTokPerS: number;
  // 延迟分段（p95）
  ttftP95: number | null; // 秒（排队+prefill+首token）
  queueP95: number | null; // 秒
  prefillP95: number | null; // 秒
  itlP95Ms: number | null; // 毫秒（逐 token）
  tpotP95Ms: number | null; // 毫秒（每输出 token）
  e2eP95: number | null; // 秒
  // 异常
  preemptRate: number; // 次/秒
}

// null 友好聚合：null 不参与，全 null → null。
function maxNN(xs: (number | null)[]): number | null {
  let m: number | null = null;
  for (const x of xs) if (x != null && (m == null || x > m)) m = x;
  return m;
}
function avgNN(xs: (number | null)[]): number | null {
  let sum = 0; let n = 0;
  for (const x of xs) if (x != null) { sum += x; n++; }
  return n > 0 ? sum / n : null;
}

// 把一组连续点压成一个桶。Grafana 式降采样：
// gauges/峰值类(并发/排队/KV/抢占) 取 max（保住尖峰，诊断要看最坏）；
// 吞吐(tok/s)取 avg（老实反映平均吞吐，max 会高估）；
// 延迟分位(p95) 取 max（突出最坏子窗口，且 null 友好——只要桶内任一子窗口有值就出值，
//   顺带填上稀疏窗口下 TTFT/queue/prefill「时有时无」的空洞）。
function mergeBucket(g: HistoryPoint[]): HistoryPoint {
  const mid = g[Math.floor(g.length / 2)];
  return {
    tsMs: mid.tsMs,
    running: Math.max(...g.map((p) => p.running)),
    waiting: Math.max(...g.map((p) => p.waiting)),
    waitingCapacity: Math.max(...g.map((p) => p.waitingCapacity)),
    waitingDeferred: Math.max(...g.map((p) => p.waitingDeferred)),
    kvPerc: Math.max(...g.map((p) => p.kvPerc)),
    prefixHitPerc: avgNN(g.map((p) => p.prefixHitPerc)),
    genTokPerS: (avgNN(g.map((p) => p.genTokPerS)) ?? 0),
    promptTokPerS: (avgNN(g.map((p) => p.promptTokPerS)) ?? 0),
    ttftP95: maxNN(g.map((p) => p.ttftP95)),
    queueP95: maxNN(g.map((p) => p.queueP95)),
    prefillP95: maxNN(g.map((p) => p.prefillP95)),
    itlP95Ms: maxNN(g.map((p) => p.itlP95Ms)),
    tpotP95Ms: maxNN(g.map((p) => p.tpotP95Ms)),
    e2eP95: maxNN(g.map((p) => p.e2eP95)),
    preemptRate: Math.max(...g.map((p) => p.preemptRate)),
  };
}

// 按索引把连续点等分到 ≤maxPoints 个桶，桶内合并。无需 from/to，对不规则间隔也稳。
function downsamplePoints(points: HistoryPoint[], maxPoints: number): HistoryPoint[] {
  if (maxPoints <= 0 || points.length <= maxPoints) return points;
  const groupSize = Math.ceil(points.length / maxPoints);
  const out: HistoryPoint[] = [];
  for (let i = 0; i < points.length; i += groupSize) out.push(mergeBucket(points.slice(i, i + groupSize)));
  return out;
}

// maxPoints>0 时，超过该点数就做服务端降采样（恒定点数，与时间范围解耦）；0=不降采样（原始全量）。
export function buildHistorySeries(samples: InfraMetricSample[], maxPoints = 0): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;

    let genTokPerS = 0;
    let promptTokPerS = 0;
    let preemptRate = 0;
    if (prev) {
      const dt = Math.max(1e-3, (s.tsMs - prev.tsMs) / 1000);
      const dGen = (s.counters['vllm:generation_tokens_total'] ?? 0) - (prev.counters['vllm:generation_tokens_total'] ?? 0);
      const dPrompt = (s.counters['vllm:prompt_tokens_total'] ?? 0) - (prev.counters['vllm:prompt_tokens_total'] ?? 0);
      const dPreempt = (s.counters['vllm:num_preemptions_total'] ?? 0) - (prev.counters['vllm:num_preemptions_total'] ?? 0);
      genTokPerS = dGen > 0 ? dGen / dt : 0;
      promptTokPerS = dPrompt > 0 ? dPrompt / dt : 0;
      preemptRate = dPreempt > 0 ? dPreempt / dt : 0;
    }

    const q = s.counters['vllm:prefix_cache_queries_total'] ?? 0;
    const h = s.counters['vllm:prefix_cache_hits_total'] ?? 0;
    // 对「本窗口内完成请求」的直方图差分算分位（而非累计），反映当前延迟而非历史全量
    const p95 = (key: string) => histQuantile(deltaHist(s.histograms[key], prev?.histograms[key]), 0.95);
    const itlP95 = p95('vllm:inter_token_latency_seconds');
    const tpotP95 = p95('vllm:request_time_per_output_token_seconds');

    out.push({
      tsMs: s.tsMs,
      running: s.gauges['vllm:num_requests_running'] ?? 0,
      waiting: s.gauges['vllm:num_requests_waiting'] ?? 0,
      waitingCapacity: s.waitingByReason.capacity ?? 0,
      waitingDeferred: s.waitingByReason.deferred ?? 0,
      kvPerc: (s.gauges['vllm:kv_cache_usage_perc'] ?? 0) * 100,
      prefixHitPerc: q > 0 ? (h / q) * 100 : null,
      genTokPerS,
      promptTokPerS,
      ttftP95: p95('vllm:time_to_first_token_seconds'),
      queueP95: p95('vllm:request_queue_time_seconds'),
      prefillP95: p95('vllm:request_prefill_time_seconds'),
      itlP95Ms: itlP95 == null ? null : itlP95 * 1000,
      tpotP95Ms: tpotP95 == null ? null : tpotP95 * 1000,
      e2eP95: p95('vllm:e2e_request_latency_seconds'),
      preemptRate,
    });
  }
  return downsamplePoints(out, maxPoints);
}
