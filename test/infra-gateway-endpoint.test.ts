// 网关托管源（endpoint 带实例路径）+ 带鉴权拉取。
// 两条底线：① 普通裸机源的身份键必须与历史行为逐字一致（不弄坏已有的源和 session 关联）；
//          ② metrics 地址与 agent 侧 baseURL 必须归到同一个键，否则 trace 的 Infra tab 会空。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { probeEndpoint } from '@/lib/infra/registry';
import { metricsUrl, normalizeEndpoint, scrapeVllmTarget } from '@/lib/ingest/vllm/scrape';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'vllm-metrics-sample.txt'), 'utf8');

/** 记录收到的 header，并按是否带 Authorization 返回 200/401。 */
function authFetch(expected: string) {
  const seen: Array<Record<string, string> | undefined> = [];
  const impl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    seen.push(init?.headers);
    const ok = init?.headers?.Authorization === expected;
    return {
      ok,
      status: ok ? 200 : 401,
      text: async () => (ok ? FIXTURE : 'unauthorized'),
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test('裸机源身份键与历史行为逐字一致（/metrics、/v1、裸地址都归到 host:port）', () => {
  assert.equal(normalizeEndpoint('http://10.10.10.20:8000'), 'http://10.10.10.20:8000');
  assert.equal(normalizeEndpoint('http://10.10.10.20:8000/'), 'http://10.10.10.20:8000');
  assert.equal(normalizeEndpoint('http://10.10.10.20:8000/metrics'), 'http://10.10.10.20:8000');
  assert.equal(normalizeEndpoint('http://10.10.10.20:8000/v1'), 'http://10.10.10.20:8000');
  assert.equal(normalizeEndpoint('http://u:p@10.10.10.20:8000/v1?k=1'), 'http://10.10.10.20:8000');
});

test('网关托管源保留实例路径，且 metrics / baseURL / 完整调用 URL 归到同一键', () => {
  const key = 'https://gw.example.com/spark/qwen35';
  assert.equal(normalizeEndpoint('https://gw.example.com/spark/qwen35/metrics'), key);
  assert.equal(normalizeEndpoint('https://gw.example.com/spark/qwen35/v1'), key);
  assert.equal(normalizeEndpoint('https://gw.example.com/spark/qwen35/v1/chat/completions'), key);
  assert.equal(normalizeEndpoint('https://gw.example.com/spark/qwen35/'), key);
});

test('同网关的不同实例不会撞成同一个源', () => {
  assert.notEqual(
    normalizeEndpoint('https://gw.example.com/spark/qwen35/metrics'),
    normalizeEndpoint('https://gw.example.com/spark/qwen4/metrics'),
  );
});

test('带 uuid 的网关路径同样保留（另一种网关形状）', () => {
  const key = 'http://gw.example.com:8088/v2/infer/ce14720e-d9dd-4117-ab58-46c9de701d3b';
  assert.equal(normalizeEndpoint(`${key}/metrics`), key);
  assert.equal(normalizeEndpoint(`${key}/v1`), key);
});

test('metricsUrl 不破坏已经指向 /metrics 的网关地址', () => {
  const url = 'https://gw.example.com/spark/qwen35/metrics';
  assert.equal(metricsUrl(url), url);
  assert.equal(metricsUrl('https://gw.example.com/spark/qwen35'), url);
});

test('scrapeVllmTarget 带 header 才能拉到；target 是保留实例路径的身份键', async () => {
  const { impl, seen } = authFetch('bearer tok');
  const snap = await scrapeVllmTarget('https://gw.example.com/spark/qwen35/metrics', {
    fetchImpl: impl,
    tsMs: 7,
    headers: { Authorization: 'bearer tok' },
  });
  assert.deepEqual(seen[0], { Authorization: 'bearer tok' });
  assert.equal(snap.target, 'https://gw.example.com/spark/qwen35');
  assert.ok(Object.keys(snap.gauges).length > 0);
});

test('不带 header 拉带鉴权的源 → 抛 HTTP 401（不会静默产出空样本）', async () => {
  const { impl } = authFetch('bearer tok');
  await assert.rejects(
    () => scrapeVllmTarget('https://gw.example.com/spark/qwen35/metrics', { fetchImpl: impl }),
    /HTTP 401/,
  );
});

test('probeEndpoint 带 header 才可达 —— 否则 UI 的「添加源」按钮永远点不动', async () => {
  const { impl } = authFetch('bearer tok');
  const bad = await probeEndpoint('https://gw.example.com/spark/qwen35/metrics', { fetchImpl: impl });
  assert.equal(bad.reachable, false);
  assert.equal(bad.error, 'HTTP 401');

  const good = await probeEndpoint('https://gw.example.com/spark/qwen35/metrics', {
    fetchImpl: impl,
    headers: { Authorization: 'bearer tok' },
  });
  assert.equal(good.reachable, true);
  assert.ok(good.metricCount > 0);
  assert.equal(good.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
});
