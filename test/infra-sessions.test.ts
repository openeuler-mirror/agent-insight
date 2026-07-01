import assert from 'node:assert/strict';
import test from 'node:test';

import { countSessionsForEndpoint, listSessionsForEndpoint } from '@/lib/infra/sessions';
import { prismaRaw } from '@/lib/storage/prisma';

const ENDPOINT = 'http://test-infra-sessions.local:8000';
const OTHER = 'http://test-infra-sessions-other.local:8000';

// 用绝对时刻造 execution，窗口查询应只命中本 endpoint、且在 [from,to] 内的，按时间降序（最近优先）。
test('listSessionsForEndpoint：按 endpoint + 时间窗过滤并降序返回', async () => {
  await prismaRaw.execution.deleteMany({ where: { endpoint: { in: [ENDPOINT, OTHER] } } });
  const base = 1_700_000_000_000;
  try {
    await prismaRaw.execution.create({ data: { id: 'se-1', endpoint: ENDPOINT, timestamp: new Date(base + 1000), latency: 1200, model: 'M', outputTokens: 50, agentName: 'A' } });
    await prismaRaw.execution.create({ data: { id: 'se-2', endpoint: ENDPOINT, timestamp: new Date(base + 3000), latency: 800, model: 'M', outputTokens: 30, agentName: 'B' } });
    await prismaRaw.execution.create({ data: { id: 'se-out', endpoint: ENDPOINT, timestamp: new Date(base + 99_000), latency: 100, model: 'M' } }); // 窗口外
    await prismaRaw.execution.create({ data: { id: 'se-other', endpoint: OTHER, timestamp: new Date(base + 2000), latency: 100, model: 'M' } }); // 别的源

    const rows = await listSessionsForEndpoint(ENDPOINT, base, base + 5000);
    assert.equal(rows.length, 2, '只命中本 endpoint 窗口内两条');
    assert.deepEqual(rows.map(r => r.id), ['se-2', 'se-1'], '按时间降序（最近优先）');
    assert.equal(rows[0].latencyMs, 800);
    assert.equal(rows[0].agentName, 'B');
    assert.equal(typeof rows[0].tsMs, 'number');

    assert.equal(await countSessionsForEndpoint(ENDPOINT, base, base + 5000), 2, 'count 与窗口一致');
  } finally {
    await prismaRaw.execution.deleteMany({ where: { endpoint: { in: [ENDPOINT, OTHER] } } });
  }
});

test('listSessionsForEndpoint：分页 offset/limit', async () => {
  await prismaRaw.execution.deleteMany({ where: { endpoint: ENDPOINT } });
  const base = 1_700_000_000_000;
  try {
    for (let i = 0; i < 5; i++) {
      await prismaRaw.execution.create({ data: { id: `pg-${i}`, endpoint: ENDPOINT, timestamp: new Date(base + i * 1000), model: 'M' } });
    }
    assert.equal(await countSessionsForEndpoint(ENDPOINT, base, base + 10_000), 5);
    const p1 = await listSessionsForEndpoint(ENDPOINT, base, base + 10_000, { limit: 2, offset: 0 });
    const p2 = await listSessionsForEndpoint(ENDPOINT, base, base + 10_000, { limit: 2, offset: 2 });
    assert.deepEqual(p1.map(r => r.id), ['pg-4', 'pg-3'], '第一页=最近两条');
    assert.deepEqual(p2.map(r => r.id), ['pg-2', 'pg-1'], '第二页');
    assert.equal(p1.length, 2);
  } finally {
    await prismaRaw.execution.deleteMany({ where: { endpoint: ENDPOINT } });
  }
});

test('listSessionsForEndpoint：无 endpoint / 空窗口返回空', async () => {
  assert.deepEqual(await listSessionsForEndpoint('', 0, 1), []);
  assert.equal(await countSessionsForEndpoint('', 0, 1), 0);
});
