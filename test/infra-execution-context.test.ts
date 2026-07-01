import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExecutionInfraContext, summarizeExecutionInfraForDiagnosis } from '@/lib/infra/execution-context';
import { ensureSource, saveSample } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';
import type { Histogram, InfraMetricSample } from '@/lib/infra/types';

const ENDPOINT = 'http://test-infra-exec-context.local:8000';

function hist(v: number): Histogram {
  return { buckets: [{ le: v, count: 2 }, { le: Infinity, count: 2 }], sum: v * 2, count: 2 };
}

function sample(tsMs: number): InfraMetricSample {
  return {
    tsMs,
    source: 'vllm-pull',
    target: ENDPOINT,
    model: 'M',
    gauges: {
      'vllm:num_requests_running': 42,
      'vllm:num_requests_waiting': 9,
      'vllm:kv_cache_usage_perc': 0.91,
    },
    counters: {
      'vllm:generation_tokens_total': tsMs,
      'vllm:prompt_tokens_total': tsMs / 2,
      'vllm:num_preemptions_total': tsMs / 1000,
    },
    histograms: {
      'vllm:request_queue_time_seconds': hist(1.4),
      'vllm:request_prefill_time_seconds': hist(0.3),
      'vllm:inter_token_latency_seconds': hist(0.05),
    },
    waitingByReason: { capacity: 9 },
  };
}

test('buildExecutionInfraContext：返回 session 级 infra 诊断卡与 LLM 摘要', async () => {
  await prismaRaw.execution.deleteMany({ where: { endpoint: ENDPOINT } });
  await prismaRaw.infraSource.deleteMany({ where: { endpoint: ENDPOINT } });
  const rootId = 'infra-context-root';
  const childId = 'infra-context-child';
  try {
    const base = 1_700_000_000_000;
    await prismaRaw.execution.create({
      data: { id: rootId, endpoint: ENDPOINT, timestamp: new Date(base + 5000), latency: 5000, model: 'M', outputTokens: 120, rootExecutionId: rootId },
    });
    await prismaRaw.execution.create({
      data: { id: childId, endpoint: ENDPOINT, timestamp: new Date(base + 7000), latency: 2000, model: 'M', outputTokens: 40, rootExecutionId: rootId, parentExecutionId: rootId, isSubagent: true },
    });
    const source = await ensureSource({ endpoint: ENDPOINT, scrapeUrl: `${ENDPOINT}/metrics`, model: 'M' });
    await saveSample(source.id, sample(base + 1000));
    await saveSample(source.id, sample(base + 4000));
    await saveSample(source.id, sample(base + 6500));

    const context = await buildExecutionInfraContext(childId);
    assert.ok(context);
    assert.equal(context.rootExecutionId, rootId);
    assert.equal(context.cards.length, 1);
    assert.equal(context.cards[0].endpoint, ENDPOINT);
    assert.equal(context.cards[0].correlated, true);
    assert.equal(context.cards[0].samples, 3);
    assert.equal(context.cards[0].classification?.label, 'INFRA-BOUND');
    assert.equal(context.cards[0].metrics.waitingPeak, 9);
    assert.equal(context.cards[0].metrics.kvPeakPerc, 91);

    const summary = summarizeExecutionInfraForDiagnosis(context);
    assert.match(summary, /推理 Infra 观测指标/);
    assert.match(summary, /INFRA-BOUND/);
    assert.match(summary, /queue_p95=1\.33s/);
    assert.match(summary, /kv_peak=91\.0%/);
  } finally {
    await prismaRaw.execution.deleteMany({ where: { id: { in: [rootId, childId] } } });
    await prismaRaw.infraSource.deleteMany({ where: { endpoint: ENDPOINT } });
  }
});
