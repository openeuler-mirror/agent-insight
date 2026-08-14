import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  histAvg,
  histQuantile,
  normalize,
  normalizeByModel,
  parsePromText,
} from '@/lib/ingest/vllm/prom-text';
import type { Histogram } from '@/lib/infra/types';

// 夹具 = 真实 GX10 vLLM /metrics 抓取（model = Qwen3-Coder-30B-A3B-Instruct-FP8）。
const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'vllm-metrics-sample.txt'),
  'utf8',
);

test('parsePromText 提取族类型与扁平样本', () => {
  const parsed = parsePromText(FIXTURE);
  assert.ok(parsed.samples.length > 100, '应解析出大量样本');
  // TYPE 行被记录到族里
  const fam = parsed.families.get('vllm:num_requests_running');
  assert.equal(fam?.type, 'gauge');
  // 带 label 的样本被正确拆分
  const flops = parsed.samples.find((s) => s.name === 'vllm:estimated_flops_per_gpu_total');
  assert.equal(flops?.labels.model_name, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
});

test('normalize 归一到 InfraMetricSample 各分区', () => {
  const snap = normalize(parsePromText(FIXTURE), { target: 'http://gx10:8000/metrics', tsMs: 1000 });

  assert.equal(snap.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
  assert.equal(snap.source, 'vllm-pull');
  assert.equal(snap.target, 'http://gx10:8000/metrics');
  assert.equal(snap.tsMs, 1000);

  // gauges：三个调度/KV 信号都在且为数值
  for (const k of ['vllm:num_requests_running', 'vllm:num_requests_waiting', 'vllm:kv_cache_usage_perc']) {
    assert.equal(typeof snap.gauges[k], 'number', `gauge ${k} 缺失`);
  }

  // counters：吞吐 + prefix cache 累计值
  assert.ok(snap.counters['vllm:prompt_tokens_total'] > 0);
  assert.ok(snap.counters['vllm:generation_tokens_total'] > 0);
  // 此 build 的 roofline 估算恒为 0（spike 已确认）
  assert.equal(snap.counters['vllm:estimated_flops_per_gpu_total'], 0);

  // prefix cache 命中率（累计）应在 90%~100%（spike 实测 95.6%）
  const q = snap.counters['vllm:prefix_cache_queries_total'];
  const hit = snap.counters['vllm:prefix_cache_hits_total'];
  const ratio = hit / q;
  assert.ok(ratio > 0.9 && ratio <= 1.0, `prefix 命中率 ${ratio} 不在预期区间`);
});

test('normalize 直方图：桶升序、avg/quantile 可算', () => {
  const snap = normalize(parsePromText(FIXTURE));
  const ttft = snap.histograms['vllm:time_to_first_token_seconds'];
  assert.ok(ttft && ttft.count > 0, 'TTFT 直方图应有样本');

  // 桶按 le 升序
  for (let i = 1; i < ttft.buckets.length; i++) {
    assert.ok(ttft.buckets[i].le >= ttft.buckets[i - 1].le, '桶未升序');
  }
  // p95 >= p50，avg 有限
  const p50 = histQuantile(ttft, 0.5);
  const p95 = histQuantile(ttft, 0.95);
  assert.ok(p50 != null && p95 != null && p95 >= p50);
  assert.ok(Number.isFinite(histAvg(ttft) as number));
});

test('normalizeByModel 按 model_name 拆成每模型一条', () => {
  const text = [
    '# TYPE vllm:num_requests_running gauge',
    'vllm:num_requests_running{model_name="A"} 3',
    'vllm:num_requests_running{model_name="B"} 7',
    '# TYPE vllm:generation_tokens_total counter',
    'vllm:generation_tokens_total{model_name="A"} 100',
    'vllm:generation_tokens_total{model_name="B"} 200',
    'vllm:time_to_first_token_seconds_bucket{model_name="A",le="0.5"} 1',
    'vllm:time_to_first_token_seconds_bucket{model_name="A",le="+Inf"} 1',
    'vllm:time_to_first_token_seconds_count{model_name="A"} 1',
    'vllm:time_to_first_token_seconds_sum{model_name="A"} 0.4',
  ].join('\n');
  const out = normalizeByModel(parsePromText(text), { tsMs: 5 });
  assert.equal(out.length, 2);
  const A = out.find((s) => s.model === 'A');
  const B = out.find((s) => s.model === 'B');
  assert.equal(A?.gauges['vllm:num_requests_running'], 3);
  assert.equal(B?.gauges['vllm:num_requests_running'], 7);
  assert.equal(A?.counters['vllm:generation_tokens_total'], 100);
  assert.equal(B?.counters['vllm:generation_tokens_total'], 200);
  // 直方图也按模型归属
  assert.equal(A?.histograms['vllm:time_to_first_token_seconds']?.count, 1);
  assert.equal(B?.histograms['vllm:time_to_first_token_seconds'], undefined);
  // 单模型夹具 → 长度 1
  assert.equal(normalizeByModel(parsePromText(FIXTURE)).length, 1);
});

test('histQuantile 桶内线性插值 + 边界', () => {
  const h: Histogram = {
    buckets: [
      { le: 1, count: 1 },
      { le: 2, count: 2 },
      { le: Infinity, count: 2 },
    ],
    sum: 2.5,
    count: 2,
  };
  assert.equal(histQuantile(h, 0.5), 1); // target=1 命中第一桶边界
  assert.equal(histQuantile(h, 0.75), 1.5); // target=1.5 在 [1,2] 内插值
  assert.equal(histAvg(h), 1.25);

  // 空直方图返回 null，不抛
  const empty: Histogram = { buckets: [], sum: 0, count: 0 };
  assert.equal(histQuantile(empty, 0.95), null);
  assert.equal(histQuantile(undefined, 0.95), null);
  assert.equal(histAvg(empty), null);
});

test('histQuantile：le 为 null 的桶等同 +Inf（JSON 往返后的形态），不能被当成 0', () => {
  // JSON.stringify(Infinity) === 'null' → 落库读回来最后一个桶就是 { le: null }。
  // 少了兜底会走插值分支把 null 当 0 算，得到 prevLe*(1-frac)，把最坏尾延迟静默缩小。
  const roundTripped = JSON.parse(JSON.stringify({
    buckets: [{ le: 100, count: 1 }, { le: Infinity, count: 10 }], sum: 0, count: 10,
  })) as Histogram;
  assert.equal(roundTripped.buckets[1].le, null, '前提：JSON 往返后 +Inf 变成 null');

  // p95 落在 +Inf 桶（只有 1 个请求 ≤100s，其余 9 个更慢）→ 应回退到最后一个有限边界 100
  assert.equal(histQuantile(roundTripped, 0.95), 100);
});
