import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { diagnoseTarget } from '@/lib/infra/probe';
import { GET } from '@/app/api/observe/infra/diagnose/route';

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures', 'vllm-metrics-sample.txt'),
  'utf8',
);

function fakeFetch(text: string): typeof fetch {
  return (async () => ({ ok: true, status: 200, text: async () => text })) as unknown as typeof fetch;
}

test('diagnoseTarget 拉取 + 诊断 → 摘要(verdict/slis/findings)', async () => {
  const s = await diagnoseTarget('http://vllm.test:8000', { fetchImpl: fakeFetch(FIXTURE) });
  assert.equal(s.target, 'http://vllm.test:8000');
  assert.equal(s.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
  assert.ok(['idle', 'healthy', 'degraded', 'critical'].includes(s.verdict));
  assert.equal(typeof s.slis.kvPeakPerc, 'number');
  assert.ok(s.slis.prefixHit != null && s.slis.prefixHit > 0.9, '空载夹具 lifetime 命中率应~95%');
  assert.ok(Array.isArray(s.findings));
  assert.equal(s.samples, 1);
});

test('diagnoseTarget 容忍单次抓取失败，用成功的样本诊断', async () => {
  let call = 0;
  const flaky = (async () => {
    call += 1;
    if (call === 1) throw new Error('瞬时超时');
    return { ok: true, status: 200, text: async () => FIXTURE };
  }) as unknown as typeof fetch;
  const s = await diagnoseTarget('http://vllm.test:8000', { samples: 2, intervalMs: 0, fetchImpl: flaky });
  assert.equal(s.samples, 1, '应只用到第二次成功的样本');
  assert.equal(s.model, 'Qwen3-Coder-30B-A3B-Instruct-FP8');
});

test('diagnoseTarget 全部失败才抛错', async () => {
  const dead = (async () => { throw new Error('unreachable'); }) as unknown as typeof fetch;
  await assert.rejects(() => diagnoseTarget('http://vllm.test:8000', { samples: 2, intervalMs: 0, fetchImpl: dead }), /unreachable/);
});

test('infra/diagnose 路由：缺 target → 400', async () => {
  const res = await GET(new Request('http://localhost/api/observe/infra/diagnose'));
  assert.equal(res.status, 400);
});
