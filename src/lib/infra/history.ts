// 把一串 InfraMetricSample 压成适合画时序图的点序列，覆盖 8 大类信号：
// 调度/队列 · KV · 缓存复用 · 吞吐 · 延迟分段(直方图分位) · 异常(抢占)。
// counter 类（吞吐、抢占）用固定回看窗口算 rate（见 rateOver）；直方图取 p95。

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

// counter 速率的回看窗口。**不要**退回「相邻两帧差 ÷ 帧间隔」——那是错的：
//   ① vLLM 的 prompt_tokens_total 是突发式跳变，不是连续增长（07-01 实测：逐帧 delta 的
//      p50=0、p90=0，九成以上的帧计数器纹丝不动，然后某一帧猛跳十几万）；
//   ② 推送间隔抖得厉害（同段实测 dt ∈ [131ms, 5116ms]，标称 2s）。
// 两者相乘 ⇒ 一坨 token 除以一个随机小间隔，读数变成「采样抖动」的函数而非「负载」的函数。
// 铁证：同一个 dPrompt=160293 因落在不同间隔里，算出 285k / 316k / 398k / 596k tok/s。
// 该窗口 6h 真实均值只有 1116 tok/s(prompt) / 4.7 tok/s(gen)，图上却显示 7.3w / 2750。
// 改成 Prometheus rate() 的做法：在 [ts-window, ts] 内取最老的一帧做**端点差分**。
// 端点差分顺带免疫乱序推送——实测 119 次 counter 回退中 0 次是真重启、96 次是下一帧就补回的
// 乱序毛刺（如 358816→358776→358826），只要毛刺不在端点上就完全不影响结果。
export const DEFAULT_RATE_WINDOW_MS = 30_000;

// 取 [i 的时刻 - window, i 的时刻] 内最老一帧的下标；窗口内只有自己（采样比窗口还稀）时退回 i-1。
// samples 按 tsMs 升序，left 单调前移 → 整体 O(n)。
function windowStart(samples: InfraMetricSample[], i: number, left: number, rateWindowMs: number): number {
  let l = left;
  while (l < i && samples[i].tsMs - samples[l].tsMs > rateWindowMs) l++;
  return l;
}

// 窗口内的计数器增量（端点差）。差值 <0 = 窗口真跨越了一次重启（计数器归零）→ 记 0。
function deltaCounter(samples: InfraMetricSample[], from: number, to: number, key: string): number {
  if (from < 0 || from >= to) return 0; // 首点无前序
  const dv = (samples[to].counters[key] ?? 0) - (samples[from].counters[key] ?? 0);
  return dv > 0 ? dv : 0;
}

// 端点差分算速率：窗口增量 ÷ 窗口实际跨度。
function rateOver(samples: InfraMetricSample[], from: number, to: number, key: string): number {
  const dv = deltaCounter(samples, from, to, key);
  if (dv <= 0) return 0;
  const dt = (samples[to].tsMs - samples[from].tsMs) / 1000;
  return dt > 0 ? dv / dt : 0;
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
// rateWindowMs = counter 速率的回看窗口（见 DEFAULT_RATE_WINDOW_MS）。
export function buildHistorySeries(
  samples: InfraMetricSample[],
  maxPoints = 0,
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  let left = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;

    // 速率端点：回看窗口内最老的一帧；窗口内只有自己（采样比窗口稀）时退回上一帧——
    // 此时帧间隔本就 ≥window，端点差分不会被小间隔放大。
    left = windowStart(samples, i, left, rateWindowMs);
    const rateFrom = left < i ? left : i - 1;
    const genTokPerS = rateOver(samples, rateFrom, i, 'vllm:generation_tokens_total');
    const promptTokPerS = rateOver(samples, rateFrom, i, 'vllm:prompt_tokens_total');
    const preemptRate = rateOver(samples, rateFrom, i, 'vllm:num_preemptions_total');

    // Prefix 命中率必须用窗口差分。直接拿累计计数器相除 = 「vLLM 开机至今」的总命中率，
    // 几乎不动，图是条假的直线（07-01 六小时实测：累计口径只在 30.9%~35.1% 之间挪了 4.2 个
    // 百分点，而真实的 30s 窗口口径在 0%~92.3% 剧烈波动；07-12 那天累计口径全天恒为 95.704）。
    // 这跟当初「延迟直方图对累计取分位」是同一类 bug——那次修了直方图，漏了 prefix cache。
    // 窗口内无新查询 → 留空（不显示陈旧值），与延迟分位的处理保持一致。
    const dQueries = deltaCounter(samples, rateFrom, i, 'vllm:prefix_cache_queries_total');
    const dHits = deltaCounter(samples, rateFrom, i, 'vllm:prefix_cache_hits_total');
    // 乱序推送可能让 dHits 轻微为负 / 略超 dQueries → 夹到 [0,100]，不让毛刺画出无意义的值
    const prefixHitPerc = dQueries > 0 ? Math.min(100, Math.max(0, (dHits / dQueries) * 100)) : null;
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
      prefixHitPerc,
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

// ——————————————————————————————————————————————————————————————
// 导出（CSV）用的行。跟画图共用同一套口径换算数学（windowStart / rateOver /
// deltaCounter / deltaHist），但两点不同：
//   ① **不做降采样**。画图那条路的 mergeBucket 对不同列用了不同聚合（峰值 max、
//      吞吐 avg），混进一张表下游无从分辨，会把跨列相关性分析带偏。导出一行一个
//      原始样本，"计算"只剩逐点的口径换算，语义干净。
//   ② **附带裸累计计数器**。用来 (a) 让人独立复核我们算的速率，(b) 回答"这段时间
//      总共处理了多少 token"这类问题 —— 首尾一减即精确，用速率列去积分反而算不准。
// 分位也从只给 p95 扩到 p50/p95/p99：图上只画 p95 是受屏幕宽度限制，CSV 没这个约束，
// 多两列就能回答"尾巴有多长"。
// ——————————————————————————————————————————————————————————————
export interface ExportRow {
  tsMs: number;
  running: number;
  waiting: number;
  waitingCapacity: number;
  waitingDeferred: number;
  kvPerc: number;
  prefixHitPerc: number | null;
  promptTokPerS: number;
  genTokPerS: number;
  preemptRate: number;
  // 延迟分位：秒（ITL/TPOT 另给毫秒列，与页面口径一致）
  ttft: Q; queue: Q; prefill: Q; e2e: Q;
  itlMs: Q; tpotMs: Q;
  // 裸累计计数器（vLLM 启动至今），供复核与总量计算
  promptTokensTotal: number | null;
  generationTokensTotal: number | null;
  prefixCacheQueriesTotal: number | null;
  prefixCacheHitsTotal: number | null;
  numPreemptionsTotal: number | null;
}
/** 一个指标的三个分位；窗口内无新完成请求 → 三个都是 null（留空，不填 0）。 */
export interface Q { p50: number | null; p95: number | null; p99: number | null; }

const NO_Q: Q = { p50: null, p95: null, p99: null };
function quantiles(h: Histogram | undefined, scale = 1): Q {
  if (!h) return NO_Q;
  const at = (q: number) => { const v = histQuantile(h, q); return v == null ? null : v * scale; };
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
}
/** counter 原值；缺失时给 null（而不是 0）——0 会被误读成"计数器真的是 0"。 */
function raw(s: InfraMetricSample, key: string): number | null {
  const v = s.counters[key];
  return typeof v === 'number' ? v : null;
}

export function buildExportRows(
  samples: InfraMetricSample[],
  rateWindowMs = DEFAULT_RATE_WINDOW_MS,
): ExportRow[] {
  const out: ExportRow[] = [];
  let left = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prev = i > 0 ? samples[i - 1] : null;
    left = windowStart(samples, i, left, rateWindowMs);
    const rateFrom = left < i ? left : i - 1;

    const dQueries = deltaCounter(samples, rateFrom, i, 'vllm:prefix_cache_queries_total');
    const dHits = deltaCounter(samples, rateFrom, i, 'vllm:prefix_cache_hits_total');
    const dh = (key: string) => deltaHist(s.histograms[key], prev?.histograms[key]);

    out.push({
      tsMs: s.tsMs,
      running: s.gauges['vllm:num_requests_running'] ?? 0,
      waiting: s.gauges['vllm:num_requests_waiting'] ?? 0,
      waitingCapacity: s.waitingByReason.capacity ?? 0,
      waitingDeferred: s.waitingByReason.deferred ?? 0,
      kvPerc: (s.gauges['vllm:kv_cache_usage_perc'] ?? 0) * 100,
      prefixHitPerc: dQueries > 0 ? Math.min(100, Math.max(0, (dHits / dQueries) * 100)) : null,
      promptTokPerS: rateOver(samples, rateFrom, i, 'vllm:prompt_tokens_total'),
      genTokPerS: rateOver(samples, rateFrom, i, 'vllm:generation_tokens_total'),
      preemptRate: rateOver(samples, rateFrom, i, 'vllm:num_preemptions_total'),
      ttft: quantiles(dh('vllm:time_to_first_token_seconds')),
      queue: quantiles(dh('vllm:request_queue_time_seconds')),
      prefill: quantiles(dh('vllm:request_prefill_time_seconds')),
      e2e: quantiles(dh('vllm:e2e_request_latency_seconds')),
      itlMs: quantiles(dh('vllm:inter_token_latency_seconds'), 1000),
      tpotMs: quantiles(dh('vllm:request_time_per_output_token_seconds'), 1000),
      promptTokensTotal: raw(s, 'vllm:prompt_tokens_total'),
      generationTokensTotal: raw(s, 'vllm:generation_tokens_total'),
      prefixCacheQueriesTotal: raw(s, 'vllm:prefix_cache_queries_total'),
      prefixCacheHitsTotal: raw(s, 'vllm:prefix_cache_hits_total'),
      numPreemptionsTotal: raw(s, 'vllm:num_preemptions_total'),
    });
  }
  return out;
}
