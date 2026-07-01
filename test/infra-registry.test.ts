import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { deriveCandidates, probeEndpoint } from '@/lib/infra/registry';
import { pollOnce } from '@/lib/infra/poller';
import { ensureSource, querySamples } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'vllm-metrics-sample.txt'), 'utf8');

function fakeFetch(text: string, status = 200): typeof fetch {
  return (async () => ({ ok: status >= 200 && status < 300, status, text: async () => text })) as unknown as typeof fetch;
}

test('deriveCandidates 按归一 endpoint 分组，跳过 null/非法', () => {
  const cands = deriveCandidates([
    { endpoint: 'http://a:8000/v1', model: 'M1' },
    { endpoint: 'http://a:8000/v2', model: 'M2' },
    { endpoint: 'http://b:9000', model: 'M1' },
    { endpoint: null, model: 'M1' },
    { endpoint: 'not-a-url', model: 'M1' },
  ]);
  assert.equal(cands.length, 2);
  const a = cands.find((c) => c.endpoint === 'http://a:8000');
  assert.equal(a?.count, 2);
  assert.deepEqual(a?.models.sort(), ['M1', 'M2']);
  assert.equal(cands[0].endpoint, 'http://a:8000'); // 按 count 降序
});

test('probeEndpoint 可达 vLLM → reachable + metricCount + model', async () => {
  const r = await probeEndpoint('http://x:8000', { fetchImpl: fakeFetch(FIXTURE) });
  assert.equal(r.reachable, true);
  assert.ok(r.metricCount > 0);
  assert.equal(r.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
});

test('probeEndpoint 非 vLLM / 不可达 → not reachable', async () => {
  const notVllm = await probeEndpoint('http://x:8000', { fetchImpl: fakeFetch('# some other metrics\nfoo 1\n') });
  assert.equal(notVllm.reachable, false);
  const down = await probeEndpoint('http://x:8000', { fetchImpl: fakeFetch('', 500) });
  assert.equal(down.reachable, false);
  assert.match(down.error ?? '', /HTTP 500/);
});

test('pollOnce 抓启用 pull 源并落样本', async () => {
  const endpoint = 'http://test-poller.local:9998';
  await prismaRaw.infraSource.deleteMany({ where: { endpoint } });
  const src = await ensureSource({ endpoint, scrapeUrl: `${endpoint}/metrics`, kind: 'pull' });
  try {
    const res = await pollOnce({ fetchImpl: fakeFetch(FIXTURE), tsMs: 5000, endpoints: [endpoint] });
    assert.equal(res.polled, 1);
    assert.equal(res.failed, 0);
    const samples = await querySamples(src.id, 0, 10000);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
  } finally {
    await prismaRaw.infraSource.deleteMany({ where: { endpoint } });
  }
});
