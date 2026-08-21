import assert from 'node:assert/strict';
import test from 'node:test';

import { deserializeRow, ensureSource, querySamples, saveSample, serializeSample } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';
import type { InfraMetricSample } from '@/lib/infra/types';

function sample(tsMs: number): InfraMetricSample {
  return {
    tsMs,
    source: 'vllm-pull',
    target: 'http://x:8000',
    model: 'M',
    gauges: { 'vllm:num_requests_running': 3 },
    counters: { 'vllm:generation_tokens_total': 1000 },
    // 末桶 le=+Inf 是 vLLM 直方图的真实形态，务必留着：JSON.stringify(Infinity) 是 'null'，
    // 这个 fixture 正好让「往返保真」用例守住 +Inf 被落库吃掉的回归。
    histograms: {
      'vllm:time_to_first_token_seconds': {
        buckets: [{ le: 1, count: 2 }, { le: Infinity, count: 2 }], sum: 1.5, count: 2,
      },
    },
    waitingByReason: { capacity: 1 },
  };
}

test('serialize/deserialize 往返保真', () => {
  const s = sample(1234);
  const row = serializeSample('src1', s);
  const back = deserializeRow({ ...row, source: { endpoint: 'http://x:8000' } });
  assert.equal(back.tsMs, s.tsMs);
  assert.equal(back.model, s.model);
  assert.deepEqual(back.gauges, s.gauges);
  assert.deepEqual(back.counters, s.counters);
  assert.deepEqual(back.histograms, s.histograms);
  assert.deepEqual(back.waitingByReason, s.waitingByReason);
});

test('反序列化把 +Inf 桶还原回来（JSON 会把 Infinity 存成 null）', () => {
  const row = serializeSample('src1', sample(1));
  assert.match(row.histograms, /"le":null/, '前提：落库 JSON 里 +Inf 确实变成了 null');

  const back = deserializeRow({ ...row, source: null });
  const buckets = back.histograms['vllm:time_to_first_token_seconds'].buckets;
  assert.equal(buckets[buckets.length - 1].le, Infinity, '读回来必须还原成 +Inf，否则分位算法会把它当 0');
});

test('DB 往返：ensureSource + saveSample + 窗口查询', async () => {
  const endpoint = 'http://test-infra-store.local:9999';
  // 清理可能的残留
  await prismaRaw.infraSource.deleteMany({ where: { endpoint } });

  const src = await ensureSource({ endpoint, scrapeUrl: `${endpoint}/metrics`, model: 'M' });
  try {
    await saveSample(src.id, sample(1000));
    await saveSample(src.id, sample(2000));
    await saveSample(src.id, sample(9999)); // 窗口外

    const win = await querySamples(src.id, 500, 2500);
    assert.equal(win.length, 2, '窗口内应只命中两条');
    assert.equal(win[0].tsMs, 1000);
    assert.equal(win[1].tsMs, 2000);
    assert.equal(win[0].target, endpoint, 'target 应回填为源 endpoint');

    // upsert 幂等：再 ensure 同 endpoint 不新建
    const again = await ensureSource({ endpoint, scrapeUrl: `${endpoint}/metrics`, model: 'M2' });
    assert.equal(again.id, src.id);
    assert.equal(again.model, 'M2');
  } finally {
    await prismaRaw.infraSource.deleteMany({ where: { endpoint } }); // 级联删 samples
  }
});
