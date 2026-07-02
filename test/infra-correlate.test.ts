import assert from 'node:assert/strict';
import test from 'node:test';

import { classify, infraContextFor } from '@/lib/infra/correlate';
import type { Histogram, InfraMetricSample } from '@/lib/infra/types';

function hist(p: number): Histogram {
  return { buckets: [{ le: p, count: 1 }, { le: Infinity, count: 1 }], sum: p, count: 1 };
}
function snap(tsMs: number, gauges: Record<string, number>, counters: Record<string, number> = {}, hk: Record<string, number> = {}): InfraMetricSample {
  const histograms: Record<string, Histogram> = {};
  for (const [k, v] of Object.entries(hk)) histograms[k] = hist(v);
  return { tsMs, source: 't', target: 't', model: 'M', gauges, counters, histograms, waitingByReason: {} };
}

test('infraContextFor 只取命中窗口的采样', () => {
  const series = [snap(0, {}), snap(5000, {}), snap(20000, {})];
  const ctx = infraContextFor({ startMs: 4000, endMs: 6000 }, series);
  assert.equal(ctx?.samples, 1); // 仅 5000 落在 [3000,7000]
  assert.equal(infraContextFor({ startMs: 100000, endMs: 200000 }, series), null);
});

test('健康 + 延迟≈输出×TPOT → INHERENT', () => {
  const g = { 'vllm:num_requests_running': 5, 'vllm:num_requests_waiting': 0, 'vllm:kv_cache_usage_perc': 0.1 };
  // ITL avg 47ms，200 tok → 固有 ≈ 200×47 + prefill 200 ≈ 9600ms
  const series = [
    snap(0, g, { 'vllm:generation_tokens_total': 0 }, { 'vllm:inter_token_latency_seconds': 0.047, 'vllm:request_prefill_time_seconds': 0.2 }),
    snap(5000, g, { 'vllm:generation_tokens_total': 500 }, { 'vllm:inter_token_latency_seconds': 0.047, 'vllm:request_prefill_time_seconds': 0.2 }),
  ];
  const ctx = infraContextFor({ startMs: 0, endMs: 5000 }, series);
  const cls = classify({ startMs: 0, endMs: 5000, latencyMs: 9800, outTokens: 200 }, ctx);
  assert.equal(cls.label, 'INHERENT');
});

test('健康但延迟远超固有 → APP-BOUND', () => {
  const g = { 'vllm:num_requests_running': 5, 'vllm:num_requests_waiting': 0, 'vllm:kv_cache_usage_perc': 0.1 };
  const series = [
    snap(0, g, { 'vllm:generation_tokens_total': 0 }, { 'vllm:inter_token_latency_seconds': 0.047 }),
    snap(5000, g, { 'vllm:generation_tokens_total': 500 }, { 'vllm:inter_token_latency_seconds': 0.047 }),
  ];
  const ctx = infraContextFor({ startMs: 0, endMs: 5000 }, series);
  // 200 tok 固有 ~9.6s，但实际 60s → 6× → APP-BOUND
  const cls = classify({ startMs: 0, endMs: 5000, latencyMs: 60000, outTokens: 200 }, ctx);
  assert.equal(cls.label, 'APP-BOUND');
});

test('窗口内排队/抢占受压 → INFRA-BOUND（同一调用翻转）', () => {
  const g0 = { 'vllm:num_requests_running': 50, 'vllm:num_requests_waiting': 40, 'vllm:kv_cache_usage_perc': 0.97 };
  const g1 = { 'vllm:num_requests_running': 50, 'vllm:num_requests_waiting': 55, 'vllm:kv_cache_usage_perc': 0.98 };
  const hk = { 'vllm:request_queue_time_seconds': 4.2, 'vllm:request_prefill_time_seconds': 0.3 };
  const series = [
    snap(0, g0, { 'vllm:num_preemptions_total': 30, 'vllm:generation_tokens_total': 1000 }, hk),
    snap(5000, g1, { 'vllm:num_preemptions_total': 60, 'vllm:generation_tokens_total': 1500 }, hk),
  ];
  const ctx = infraContextFor({ startMs: 0, endMs: 5000 }, series);
  const cls = classify({ startMs: 0, endMs: 5000, latencyMs: 9800, outTokens: 200 }, ctx);
  assert.equal(cls.label, 'INFRA-BOUND');
});

test('无 infra 采样 → unknown', () => {
  assert.equal(classify({ startMs: 0, endMs: 1, latencyMs: 100, outTokens: 10 }, null).label, 'unknown');
});
