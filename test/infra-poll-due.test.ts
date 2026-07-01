import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { pollDue } from '@/lib/infra/poller';
import { ensureSource, latestSamples } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';

const FIXTURE = readFileSync(join(import.meta.dirname, 'fixtures', 'vllm-metrics-sample.txt'), 'utf8');
const fakeFetch = (() => (async () => ({ ok: true, status: 200, text: async () => FIXTURE })) as unknown as typeof fetch)();

test('pollDue 按每源 scrapeIntervalMs 控制节奏', async () => {
  const endpoint = 'http://test-due.local:9997';
  await prismaRaw.infraSource.deleteMany({ where: { endpoint } });
  const src = await ensureSource({ endpoint, scrapeUrl: `${endpoint}/metrics`, kind: 'pull', scrapeIntervalMs: 10000 });
  try {
    const t = 1_000_000_000;
    // 第一次：到点（last=0）→ 拉
    let r = await pollDue({ nowMs: t, fetchImpl: fakeFetch, endpoints: [endpoint] });
    assert.equal(r.polled, 1);
    assert.equal(r.skipped, 0);

    // 5s 后：未到 10s 间隔 → 跳过
    r = await pollDue({ nowMs: t + 5000, fetchImpl: fakeFetch, endpoints: [endpoint] });
    assert.equal(r.polled, 0);
    assert.equal(r.skipped, 1);

    // 11s 后：到点 → 再拉
    r = await pollDue({ nowMs: t + 11000, fetchImpl: fakeFetch, endpoints: [endpoint] });
    assert.equal(r.polled, 1);

    const samples = await latestSamples(src.id, 10);
    assert.equal(samples.length, 2, '应只在两次到点时落了 2 条');
  } finally {
    await prismaRaw.infraSource.deleteMany({ where: { endpoint } });
  }
});
