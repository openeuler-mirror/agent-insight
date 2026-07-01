import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { metricsUrl, normalizeEndpoint, scrapeVllmTarget } from '@/lib/ingest/vllm/scrape';

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'vllm-metrics-sample.txt'),
  'utf8',
);

// 造一个返回固定文本的假 fetch。
function fakeFetch(text: string, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
  })) as unknown as typeof fetch;
}

test('normalizeEndpoint 剔除 path/query/凭证 → scheme://host:port', () => {
  assert.equal(normalizeEndpoint('http://user:pass@vllm.test:8000/v1?k=1'), 'http://vllm.test:8000');
  assert.equal(normalizeEndpoint('http://vllm.test:8000/metrics'), 'http://vllm.test:8000');
});

test('metricsUrl 补 /metrics 且去凭证/query', () => {
  assert.equal(metricsUrl('http://h:8000'), 'http://h:8000/metrics');
  assert.equal(metricsUrl('http://h:8000/'), 'http://h:8000/metrics');
  assert.equal(metricsUrl('http://h:8000/metrics'), 'http://h:8000/metrics');
  assert.equal(metricsUrl('http://u:p@h:8000/v1?x=1'), 'http://h:8000/v1/metrics');
});

test('scrapeVllmTarget 拉取并归一，target = 归一后的源身份', async () => {
  const snap = await scrapeVllmTarget('http://vllm.test:8000', {
    fetchImpl: fakeFetch(FIXTURE),
    tsMs: 42,
  });
  assert.equal(snap.source, 'vllm-pull');
  assert.equal(snap.target, 'http://vllm.test:8000');
  assert.equal(snap.tsMs, 42);
  assert.equal(snap.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
  assert.ok(Object.keys(snap.gauges).length > 0);
});

test('scrapeVllmTarget 在 HTTP 非 2xx 时抛错', async () => {
  await assert.rejects(
    () => scrapeVllmTarget('http://h:8000', { fetchImpl: fakeFetch('', 503) }),
    /HTTP 503/,
  );
});
