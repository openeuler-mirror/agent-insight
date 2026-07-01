import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregate, diagnose } from '@/lib/infra/diagnose';
import type { Histogram, InfraMetricSample } from '@/lib/infra/types';

// 单点直方图：p95≈p（一个落在 [p] 桶里的样本）。
function hist(p: number): Histogram {
  return { buckets: [{ le: p, count: 1 }, { le: Infinity, count: 1 }], sum: p, count: 1 };
}

function snap(
  tsMs: number,
  gauges: Record<string, number>,
  counters: Record<string, number> = {},
  histKeys: Record<string, number> = {},
): InfraMetricSample {
  const histograms: Record<string, Histogram> = {};
  for (const [k, v] of Object.entries(histKeys)) histograms[k] = hist(v);
  return {
    tsMs,
    source: 'test',
    target: 'test',
    model: 'Qwen3-Coder-30B-A3B-Instruct-FP8',
    gauges,
    counters,
    histograms,
    waitingByReason: {},
  };
}

test('空载 → verdict=idle，无瓶颈', () => {
  const res = diagnose(aggregate(snap(0, { 'vllm:num_requests_running': 0 })));
  assert.equal(res.verdict, 'idle');
  assert.equal(res.bottleneck, 'none');
});

test('健康有余量 → verdict=healthy，含 headroom，prefix/decode 健康', () => {
  const g = { 'vllm:num_requests_running': 10, 'vllm:num_requests_waiting': 0, 'vllm:kv_cache_usage_perc': 0.1 };
  const ctr = (q: number, h: number, gen: number) => ({
    'vllm:prefix_cache_queries_total': q,
    'vllm:prefix_cache_hits_total': h,
    'vllm:generation_tokens_total': gen,
  });
  const series = [
    snap(0, g, ctr(1000, 950, 0), { 'vllm:inter_token_latency_seconds': 0.05 }),
    snap(5000, g, ctr(2000, 1900, 500), { 'vllm:inter_token_latency_seconds': 0.05 }),
  ];
  const res = diagnose(aggregate(series));
  assert.equal(res.verdict, 'healthy');
  assert.ok(res.findings.some((x) => x.cls === 'headroom'), '应报有余量');
  assert.ok(res.findings.some((x) => x.cls === 'cache' && x.sev === 'healthy'), 'prefix 命中应判健康');
  assert.ok(res.findings.some((x) => x.cls === 'bandwidth' && x.sev === 'healthy'), 'decode 应判健康');
});

test('decode 带宽受限 → degraded/bandwidth，且 headroom 不与之并存(排序修复)', () => {
  const g = { 'vllm:num_requests_running': 30, 'vllm:num_requests_waiting': 0, 'vllm:kv_cache_usage_perc': 0.45 };
  const ctr = (gen: number) => ({ 'vllm:generation_tokens_total': gen });
  const series = [
    snap(0, g, ctr(0), { 'vllm:inter_token_latency_seconds': 0.42 }),
    snap(5000, g, ctr(600), { 'vllm:inter_token_latency_seconds': 0.42 }),
  ];
  const res = diagnose(aggregate(series));
  assert.equal(res.verdict, 'degraded');
  assert.equal(res.bottleneck, 'bandwidth');
  assert.ok(res.findings.some((x) => x.cls === 'bandwidth' && x.sev === 'warn'));
  assert.ok(!res.findings.some((x) => x.cls === 'headroom'), 'bandwidth 告警时不应并出 headroom');
});

test('排队过载 + KV 满 + 抢占 → critical', () => {
  const g0 = { 'vllm:num_requests_running': 40, 'vllm:num_requests_waiting': 35, 'vllm:kv_cache_usage_perc': 0.97 };
  const g1 = { 'vllm:num_requests_running': 40, 'vllm:num_requests_waiting': 48, 'vllm:kv_cache_usage_perc': 0.98 };
  const hk = {
    'vllm:request_queue_time_seconds': 3.8,
    'vllm:request_prefill_time_seconds': 0.3,
    'vllm:time_to_first_token_seconds': 4.2,
  };
  const series = [
    snap(0, g0, { 'vllm:num_preemptions_total': 0, 'vllm:generation_tokens_total': 1000 }, hk),
    snap(5000, g1, { 'vllm:num_preemptions_total': 22, 'vllm:generation_tokens_total': 3000 }, hk),
  ];
  const res = diagnose(aggregate(series));
  assert.equal(res.verdict, 'critical');
  assert.equal(res.bottleneck, 'queue'); // 多个 critical 时取最先命中的类别
  assert.ok(res.findings.some((x) => x.cls === 'queue' && x.sev === 'critical'));
  assert.ok(res.findings.some((x) => x.cls === 'kv' && x.sev === 'critical'));
  assert.ok(res.findings.some((x) => x.title.includes('抢占')), '应报抢占');
});

test('prefix 命中率低 → degraded/cache', () => {
  const g = { 'vllm:num_requests_running': 5, 'vllm:num_requests_waiting': 0, 'vllm:kv_cache_usage_perc': 0.2 };
  const series = [
    snap(0, g, { 'vllm:prefix_cache_queries_total': 1000, 'vllm:prefix_cache_hits_total': 100, 'vllm:generation_tokens_total': 0 }),
    snap(5000, g, { 'vllm:prefix_cache_queries_total': 2000, 'vllm:prefix_cache_hits_total': 300, 'vllm:generation_tokens_total': 200 }),
  ];
  const res = diagnose(aggregate(series));
  assert.equal(res.bottleneck, 'cache');
  assert.equal(res.verdict, 'degraded');
});

test('hardwareProfile 影响带宽建议措辞', () => {
  const g = { 'vllm:num_requests_running': 30, 'vllm:num_requests_waiting': 0, 'vllm:kv_cache_usage_perc': 0.45 };
  const series = [
    snap(0, g, { 'vllm:generation_tokens_total': 0 }, { 'vllm:inter_token_latency_seconds': 0.42 }),
    snap(5000, g, { 'vllm:generation_tokens_total': 600 }, { 'vllm:inter_token_latency_seconds': 0.42 }),
  ];
  const res = diagnose(aggregate(series), { name: 'H100', memBandwidthGBs: 3350 });
  const bw = res.findings.find((x) => x.cls === 'bandwidth');
  assert.ok(bw?.evidence.includes('H100') && bw.evidence.includes('3350'), '证据应带入传入的硬件画像');
});
