import assert from 'node:assert/strict';
import test from 'node:test';

import { buildHistorySeries } from '@/lib/infra/history';
import type { Histogram, InfraMetricSample } from '@/lib/infra/types';

// hc = 累计完成数（相邻样本不同 → 直方图差分非零）；单桶 le=p
function hist(p: number, hc = 1): Histogram {
  return { buckets: [{ le: p, count: hc }, { le: Infinity, count: hc }], sum: p * hc, count: hc };
}
function snap(tsMs: number, gen: number, q: number, h: number, prompt = 0, preempt = 0, hc = 1): InfraMetricSample {
  return {
    tsMs, source: 't', target: 't', model: 'M',
    gauges: { 'vllm:num_requests_running': 3, 'vllm:num_requests_waiting': 1, 'vllm:kv_cache_usage_perc': 0.25 },
    counters: {
      'vllm:generation_tokens_total': gen, 'vllm:prompt_tokens_total': prompt,
      'vllm:num_preemptions_total': preempt,
      'vllm:prefix_cache_queries_total': q, 'vllm:prefix_cache_hits_total': h,
    },
    histograms: {
      'vllm:time_to_first_token_seconds': hist(0.8, hc),
      'vllm:inter_token_latency_seconds': hist(0.05, hc),
      'vllm:request_time_per_output_token_seconds': hist(0.06, hc),
      'vllm:request_queue_time_seconds': hist(0.1, hc),
    },
    waitingByReason: { capacity: 1, deferred: 2 },
  };
}

test('buildHistorySeries 覆盖 8 类信号 + 端点差分算 rate', () => {
  const series = buildHistorySeries([
    snap(0, 1000, 1000, 950, 5000, 0, 1),
    snap(5000, 1500, 2000, 1900, 6000, 2, 5), // 5s: +500 gen, +1000 prompt, +2 preempt, 直方图 +4 完成
  ]);
  assert.equal(series.length, 2);
  // 吞吐（两帧都落在 30s 回看窗口内 → 端点差分 = 全区间差 / 5s）
  assert.equal(series[0].genTokPerS, 0); // 首点无前序
  assert.equal(series[1].genTokPerS, 100);
  assert.equal(series[1].promptTokPerS, 200);
  assert.equal(series[1].preemptRate, 0.4); // 2/5s
  // 调度/队列
  assert.equal(series[1].running, 3);
  assert.equal(series[1].waitingCapacity, 1);
  assert.equal(series[1].waitingDeferred, 2);
  // KV / 缓存
  assert.equal(series[1].kvPerc, 25);
  assert.equal(series[1].prefixHitPerc, 95);
  // 延迟分段（差分后单桶 le=0.05 → p95=47.5ms）
  assert.equal(series[1].itlP95Ms, 47.5);
  assert.ok(series[1].ttftP95 != null && series[1].queueP95 != null && series[1].tpotP95Ms != null);
  // 首点无前序 → 直方图分位留空
  assert.equal(series[0].ttftP95, null);
});

test('延迟分位用窗口差分而非累计：反映新请求而非历史全量', () => {
  // 历史 100 个请求都很快(≤1s)；窗口内新完成 2 个都很慢(落在 1~2s 桶)
  const e2e = (c1: number, c2: number): Histogram => ({
    buckets: [{ le: 1, count: c1 }, { le: 2, count: c2 }, { le: Infinity, count: c2 }],
    sum: 0, count: c2,
  });
  const mk = (tsMs: number, c1: number, c2: number): InfraMetricSample => ({
    tsMs, source: 't', target: 't', model: 'M', gauges: {}, counters: {},
    histograms: { 'vllm:e2e_request_latency_seconds': e2e(c1, c2) }, waitingByReason: {},
  });
  // prev: 全 100 个都 ≤1s；cur: 新增 2 个落在 (1,2] → 累计 p95 仍≈快, 窗口 p95 应≈慢(>1.5)
  const series = buildHistorySeries([mk(0, 100, 100), mk(2000, 100, 102)]);
  assert.ok(series[1].e2eP95 != null && series[1].e2eP95 > 1.5, `窗口 p95 应反映慢的新请求，实际=${series[1].e2eP95}`);
});

test('窗口内无新完成请求 → 延迟分位留空(null)，不显示陈旧累计值', () => {
  // 两帧直方图累计 count 相同 = 这 2s 无请求完成
  const series = buildHistorySeries([
    snap(0, 1000, 0, 0, 0, 0, 7),
    snap(2000, 1000, 0, 0, 0, 0, 7), // hc 不变 → 直方图 delta=0
  ]);
  assert.equal(series[1].ttftP95, null);
  assert.equal(series[1].itlP95Ms, null);
});

test('空序列返回空', () => {
  assert.deepEqual(buildHistorySeries([]), []);
});

// —— counter 速率：回看窗口 vs 相邻帧差分 ——
// rateWindowMs=1 会让回看窗口退化成「上一帧」，正好复现修复前的老算法，用来做对照。
const ADJACENT = 1;
type HistoryPointLike = { tsMs: number; promptTokPerS: number };

test('吞吐用回看窗口而非相邻帧：突发计数器 + 抖动间隔不再把读数放大 1~2 个数量级', () => {
  // 真实负载：每 10s 完成一坨 30000 token 的 prefill → 真实均值恒为 3000 tok/s。
  // 采样：标称 2s 但抖动（复刻 GX10 实测的 131ms~5116ms 推送抖动）。
  const jitter = [2000, 250, 4700, 1300, 2500, 200, 3300, 1900, 850, 2000];
  const samples: InfraMetricSample[] = [];
  for (let ts = 0, k = 0; ts < 120_000; ts += jitter[k++ % jitter.length]) {
    samples.push(snap(ts, 0, 0, 0, Math.floor(ts / 10_000) * 30_000, 0, 1));
  }
  const after = (ps: { tsMs: number; promptTokPerS: number }[]) =>
    ps.filter((p) => p.tsMs >= 40_000).map((p) => p.promptTokPerS); // 跳过窗口未填满的开头

  const win = after(buildHistorySeries(samples, 0, 30_000));
  assert.ok(Math.max(...win) < 5000, `回看窗口下读数应贴近真实 3000 tok/s，实际峰值=${Math.max(...win).toFixed(0)}`);
  assert.ok(Math.min(...win) > 1500, `不应被抹成接近 0，实际谷值=${Math.min(...win).toFixed(0)}`);

  // 老算法：同一坨 token 除以随机小间隔 → 峰值被抖动抬起来（这正是要修的 bug）
  const adj = after(buildHistorySeries(samples, 0, ADJACENT));
  assert.ok(Math.max(...adj) > 3 * Math.max(...win), `相邻帧差分峰值应远高于真实值（${Math.max(...adj).toFixed(0)} vs ${Math.max(...win).toFixed(0)}）`);
});

test('同一坨 token 落在不同采样间隔里：相邻帧差分读数差 10 倍，回看窗口读数一致', () => {
  // 50s 观测里只有一次突发：t=20s 记入一坨 30000 token → 真实均值 1000 tok/s。
  // 两个序列唯一的差别是「记到这坨 token 的那一帧」离上一帧多远（= 推送抖动）。
  const build = (gapMs: number) =>
    [0, 10_000, 20_000, 20_000 + gapMs, 30_000, 40_000, 50_000]
      .map((ts) => snap(ts, 0, 0, 0, ts >= 20_000 + gapMs ? 30_000 : 0, 0, 1));
  const peak = (ps: HistoryPointLike[]) => Math.max(...ps.map((p) => p.promptTokPerS));
  const at50s = (ps: HistoryPointLike[]) => ps.find((p) => p.tsMs === 50_000)!.promptTokPerS;

  const adjFast = peak(buildHistorySeries(build(200), 0, ADJACENT));
  const adjSlow = peak(buildHistorySeries(build(2000), 0, ADJACENT));
  assert.ok(adjFast > 5 * adjSlow, `相邻帧差分：同样 30000 token 因间隔不同读数差好几倍（${adjFast} vs ${adjSlow}）`);

  assert.equal(at50s(buildHistorySeries(build(200), 0, 30_000)), 1000, '回看窗口下应等于真实均值');
  assert.equal(at50s(buildHistorySeries(build(2000), 0, 30_000)), 1000, '且与采样间隔无关');
});

test('乱序推送造成的 counter 回退：端点差分不受中间毛刺影响，也不吞 token', () => {
  // 稳定 10 tok/s（每 2s +20），第 5 帧因乱序回退 40 后立刻补回 —— 回退量大于单帧增量，
  // 所以相邻帧差分会看到负值（复刻实测 358816→358776→358826，
  // 119 次回退里 0 次是真重启、96 次是这种下一帧就补回的毛刺）。
  const samples: InfraMetricSample[] = [];
  for (let i = 0; i <= 30; i++) samples.push(snap(i * 2000, 0, 0, 0, i * 20 - (i === 5 ? 40 : 0), 0, 1));

  const win = buildHistorySeries(samples, 0, 30_000).filter((p) => p.tsMs >= 20_000);
  assert.ok(win.every((p) => Math.abs(p.promptTokPerS - 10) < 2), `毛刺落在窗口中间应无影响，实际=${win.map((p) => p.promptTokPerS.toFixed(2))}`);

  // 老算法：回退帧只能记 0（token 被吞），下一帧又补偿性冲高
  const adj = buildHistorySeries(samples, 0, ADJACENT);
  assert.equal(adj[5].promptTokPerS, 0, '相邻帧差分遇回退只能记 0（token 被吞）');
  assert.ok(adj[6].promptTokPerS > 10, '下一帧补偿性冲高');
});

test('采样间隔比回看窗口还稀 → 退回相邻帧，不会算成 0', () => {
  // 每 60s 一帧、窗口 30s：窗口内只有自己，必须退回上一帧（此时间隔本就大，不存在放大风险）
  const s = buildHistorySeries([snap(0, 0, 0, 0, 0, 0, 1), snap(60_000, 0, 0, 0, 6000, 0, 1)], 0, 30_000);
  assert.equal(s[1].promptTokPerS, 100); // 6000 / 60s
});

test('Prefix 命中率用窗口口径：历史命中高但当前窗口命中低 → 图上应显示「低」', () => {
  // vLLM 开机至今：100 万次查询、95 万次命中 = 累计 95%。
  // 但当前这段窗口新增的查询几乎全是 miss（新增 10000 次查询只中 500 次 = 5%）。
  // 累计口径会一直显示 ≈95%（掩盖问题），窗口口径必须显示 ≈5%。
  const samples: InfraMetricSample[] = [];
  for (let i = 0; i <= 20; i++) {
    samples.push(snap(i * 2000, 0, 1_000_000 + i * 1000, 950_000 + i * 50, 0, 0, 1));
  }
  const series = buildHistorySeries(samples, 0, 30_000);
  const late = series.filter((p) => p.tsMs >= 30_000).map((p) => p.prefixHitPerc!);
  assert.ok(late.every((v) => Math.abs(v - 5) < 0.5), `应反映窗口内的 5%，实际=${late.map((v) => v.toFixed(1))}`);
  assert.ok(late.every((v) => v < 50), '绝不能显示成累计的 95%');
});

test('Prefix 命中率：窗口内无新查询 → 留空(null)，不显示陈旧累计值', () => {
  // 计数器完全不动 = 这段时间没有新查询
  const samples = [0, 2000, 4000, 6000].map((ts) => snap(ts, 0, 500_000, 400_000, 0, 0, 1));
  const series = buildHistorySeries(samples, 0, 30_000);
  assert.ok(series.every((p) => p.prefixHitPerc === null), '无新查询就不该画点（累计口径会画成 80%）');
});

test('Prefix 命中率：乱序毛刺不会画出 <0 或 >100 的值', () => {
  const samples: InfraMetricSample[] = [
    snap(0, 0, 1000, 900, 0, 0, 1),
    snap(2000, 0, 1010, 880, 0, 0, 1), // hits 因乱序回退 → 比值本会是负数
    snap(4000, 0, 1020, 1020, 0, 0, 1), // hits 涨得比 queries 快 → 比值本会 >100
  ];
  const series = buildHistorySeries(samples, 0, 30_000);
  for (const p of series) {
    if (p.prefixHitPerc != null) assert.ok(p.prefixHitPerc >= 0 && p.prefixHitPerc <= 100, `越界: ${p.prefixHitPerc}`);
  }
});

test('计数器真重启（端点差 <0）→ 速率记 0，不出负数', () => {
  const s = buildHistorySeries([
    snap(0, 0, 0, 0, 1_000_000, 0, 1),
    snap(2000, 0, 0, 0, 500, 0, 1), // vLLM 重启，计数器归零重来
    snap(4000, 0, 0, 0, 1500, 0, 1),
  ], 0, 30_000);
  assert.equal(s[1].promptTokPerS, 0);
  assert.ok(s.every((p) => p.promptTokPerS >= 0), '任何情况下速率不应为负');
});

test('maxPoints 降采样：恒定点数 + 峰值用 max + 吞吐用 avg', () => {
  // 60 帧、每 1s 一帧，gen 每秒 +100（稳定 100tok/s），其中第 30 帧 KV 飙到 0.9（尖峰）
  const samples: InfraMetricSample[] = [];
  for (let i = 0; i < 60; i++) {
    const s = snap(i * 1000, 1000 + i * 100, 1000, 950, 0, 0, 1 + i);
    if (i === 30) s.gauges['vllm:kv_cache_usage_perc'] = 0.9;
    samples.push(s);
  }
  const full = buildHistorySeries(samples); // 不降采样
  const ds = buildHistorySeries(samples, 10); // 降到 ≤10 桶
  assert.equal(full.length, 60);
  assert.ok(ds.length <= 10 && ds.length >= 5, `降采样点数应 ≤10，实际=${ds.length}`);
  // 尖峰用 max 聚合 → 含第 30 帧的桶应保住 0.9*100=90
  assert.ok(Math.max(...ds.map((p) => p.kvPerc)) === 90, '降采样后 KV 尖峰应被 max 保住');
  // 吞吐稳定 100/s → avg 聚合后仍≈100（非 0、非高估）。跳过首桶：含第 0 帧(无前序→0)会拉低均值，属预期。
  const gens = ds.slice(1).map((p) => p.genTokPerS);
  assert.ok(gens.every((g) => Math.abs(g - 100) < 1), `吞吐 avg 应≈100，实际=${gens}`);
});

test('降采样填空洞：桶内任一子窗口有 p95 → 该桶出值(null 友好 max)', () => {
  // 交替：偶数帧 queue 直方图有新完成、奇数帧无 → 原始序列 queueP95 时有时无
  const mk = (tsMs: number, qc: number): InfraMetricSample => ({
    tsMs, source: 't', target: 't', model: 'M', gauges: {}, counters: {},
    histograms: { 'vllm:request_queue_time_seconds': hist(0.1, qc) }, waitingByReason: {},
  });
  const samples: InfraMetricSample[] = [];
  let qc = 5;
  for (let i = 0; i < 40; i++) { if (i % 2 === 0) qc += 1; samples.push(mk(i * 1000, qc)); } // 偶数帧 delta>0
  const full = buildHistorySeries(samples);
  assert.ok(full.some((p) => p.queueP95 == null), '原始序列应有空洞');
  const ds = buildHistorySeries(samples, 8); // 每桶含多帧 → 应几乎无空洞
  assert.ok(ds.slice(1).every((p) => p.queueP95 != null), '降采样后桶内有值即出值，空洞被填');
});
