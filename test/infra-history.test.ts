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

test('buildHistorySeries 覆盖 8 类信号 + 差分算 rate', () => {
  const series = buildHistorySeries([
    snap(0, 1000, 1000, 950, 5000, 0, 1),
    snap(5000, 1500, 2000, 1900, 6000, 2, 5), // 5s: +500 gen, +1000 prompt, +2 preempt, 直方图 +4 完成
  ]);
  assert.equal(series.length, 2);
  // 吞吐(差分)
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
