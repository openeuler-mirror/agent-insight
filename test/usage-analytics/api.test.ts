import assert from 'node:assert/strict';
import test from 'node:test';

import { prismaRaw } from '@/lib/storage/prisma';
import { UsageQueue, __setUsageQueueForTest } from '@/lib/usage-analytics/queue';
import { InMemoryUsageStorage } from '@/lib/usage-analytics/storage';

const ADMIN = 'ut-usage-admin';
const NORMAL = 'ut-usage-normal';
const ADMIN_KEY = 'ut-usage-admin-key';
const NORMAL_KEY = 'ut-usage-normal-key';

async function ensureUsers() {
    for (const [username, apiKey] of [[ADMIN, ADMIN_KEY], [NORMAL, NORMAL_KEY]]) {
        await prismaRaw.user.upsert({
            where: { username },
            create: { username, apiKey },
            update: { apiKey },
        });
    }
}

async function cleanupUsers() {
    await prismaRaw.user.deleteMany({ where: { username: { in: [ADMIN, NORMAL] } } });
}

function req(url: string, apiKey?: string, init?: RequestInit) {
    const headers = new Headers(init?.headers);
    if (apiKey) headers.set('x-witty-api-key', apiKey);
    return new Request(url, { ...init, headers });
}

test.before(async () => {
    await ensureUsers();
    process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';
    process.env.AGENT_INSIGHT_ADMIN_USERS = ADMIN;
});

test.after(async () => {
    await cleanupUsers();
    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    delete process.env.AGENT_INSIGHT_ADMIN_USERS;
    __setUsageQueueForTest(null);
});

test('AC-001 普通用户访问管理 API 得到 403', async () => {
    const { GET } = await import('@/app/api/admin/usage/summary/route');
    const res = await GET(req('http://x/api/admin/usage/summary?range=7', NORMAL_KEY));
    assert.equal(res.status, 403);
});

test('AC-001 伪造 ?user=admin 仍得到 403/401', async () => {
    const { GET } = await import('@/app/api/admin/usage/summary/route');
    // 带普通用户 key 但伪造 query user
    const res = await GET(req(`http://x/api/admin/usage/summary?range=7&user=${ADMIN}`, NORMAL_KEY));
    assert.equal(res.status, 403, 'query user 不得提权');

    // 完全无 key
    const anon = await GET(req(`http://x/api/admin/usage/summary?range=7&user=${ADMIN}`));
    assert.equal(anon.status, 401);
});

test('管理员可读取 summary', async () => {
    const { GET } = await import('@/app/api/admin/usage/summary/route');
    const res = await GET(req('http://x/api/admin/usage/summary?range=7', ADMIN_KEY));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.range, '7');
    assert.equal(body.features.length, 16);
    assert.ok(Array.isArray(body.trend));
    assert.ok(typeof body.kpis.users === 'number');
});

test('range 只接受 7/30/90/all', async () => {
    const { GET } = await import('@/app/api/admin/usage/summary/route');
    const bad = await GET(req('http://x/api/admin/usage/summary?range=365', ADMIN_KEY));
    assert.equal(bad.status, 400);
});

test('featureKey 只接受注册表值', async () => {
    const { GET } = await import('@/app/api/admin/usage/features/[featureKey]/route');
    const bad = await GET(req('http://x/api/admin/usage/features/dashboard?range=7', ADMIN_KEY), {
        params: Promise.resolve({ featureKey: 'dashboard' }),
    });
    assert.equal(bad.status, 400, 'Workspace 总览不可查询');

    const ok = await GET(req('http://x/api/admin/usage/features/trace?range=7', ADMIN_KEY), {
        params: Promise.resolve({ featureKey: 'trace' }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).featureKey, 'trace');
});

test('AC-002 未配置管理员时 access 返回 isAdmin=false', async () => {
    const saved = process.env.AGENT_INSIGHT_ADMIN_USERS;
    delete process.env.AGENT_INSIGHT_ADMIN_USERS;
    try {
        const { GET } = await import('@/app/api/admin/usage/access/route');
        const res = await GET(req('http://x/api/admin/usage/access', ADMIN_KEY));
        const body = await res.json();
        assert.equal(body.enabled, true);
        assert.equal(body.isAdmin, false, 'fail-closed');

        const { GET: SUM } = await import('@/app/api/admin/usage/summary/route');
        assert.equal((await SUM(req('http://x/api/admin/usage/summary?range=7', ADMIN_KEY))).status, 403);
    } finally {
        process.env.AGENT_INSIGHT_ADMIN_USERS = saved;
    }
});

test('功能关闭时 access 返回 enabled=false', async () => {
    delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
    try {
        const { GET } = await import('@/app/api/admin/usage/access/route');
        const body = await (await GET(req('http://x/api/admin/usage/access', ADMIN_KEY))).json();
        assert.deepEqual(body, { enabled: false, isAdmin: false });
    } finally {
        process.env.AGENT_INSIGHT_USAGE_ENABLED = '1';
    }
});

test('采集 API：无 API Key 为 401', async () => {
    const { POST } = await import('@/app/api/usage/events/route');
    const res = await POST(
        req('http://x/api/usage/events', undefined, {
            method: 'POST',
            body: JSON.stringify({ events: [] }),
        })
    );
    assert.equal(res.status, 401);
});

test('采集 API：body 中伪造 user 被忽略，只用 API Key 身份', async () => {
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 1000);
    __setUsageQueueForTest(q);

    const { POST } = await import('@/app/api/usage/events/route');
    const res = await POST(
        req('http://x/api/usage/events', NORMAL_KEY, {
            method: 'POST',
            body: JSON.stringify({
                user: ADMIN,
                events: [
                    {
                        eventId: 'c-1',
                        occurredAt: '2026-08-03T02:00:00Z',
                        featureKey: 'trace',
                        eventKey: 'trace.detail.view',
                        user: ADMIN,
                    },
                ],
            }),
        })
    );
    assert.equal(res.status, 202);
    assert.equal((await res.json()).accepted, 1);

    await q.flush();
    const stored = [...st.events.values()];
    assert.equal(stored.length, 1);
    assert.equal(stored[0].user, NORMAL, 'user 必须来自 API Key，绝不来自 body');
    assert.equal(stored[0].source, 'client');
});

test('采集 API：服务端专属事件与未知事件被拒绝', async () => {
    const q = new UsageQueue(new InMemoryUsageStorage(), 1000);
    __setUsageQueueForTest(q);

    const { POST } = await import('@/app/api/usage/events/route');
    const res = await POST(
        req('http://x/api/usage/events', NORMAL_KEY, {
            method: 'POST',
            body: JSON.stringify({
                events: [
                    { eventId: 'c-a', occurredAt: '2026-08-03T02:00:00Z', featureKey: 'skill', eventKey: 'skill.download' },
                    { eventId: 'c-b', occurredAt: '2026-08-03T02:00:00Z', featureKey: 'trace', eventKey: 'nope.nope' },
                ],
            }),
        })
    );
    const body = await res.json();
    assert.equal(body.accepted, 0);
    assert.equal(body.dropped, 2);
    assert.equal(q.depth, 0);
});

test('采集 API：单批超过 50 条被拒绝', async () => {
    const { POST } = await import('@/app/api/usage/events/route');
    const events = Array.from({ length: 51 }, (_, i) => ({
        eventId: `x-${i}`,
        occurredAt: '2026-08-03T02:00:00Z',
        featureKey: 'trace',
        eventKey: 'trace.detail.view',
    }));
    const res = await POST(
        req('http://x/api/usage/events', NORMAL_KEY, { method: 'POST', body: JSON.stringify({ events }) })
    );
    assert.equal(res.status, 400);
});

test('采集 API：入队后立即返回，不等待 storage flush', async () => {
    const st = new InMemoryUsageStorage();
    const q = new UsageQueue(st, 1000);
    __setUsageQueueForTest(q);

    const { POST } = await import('@/app/api/usage/events/route');
    const res = await POST(
        req('http://x/api/usage/events', NORMAL_KEY, {
            method: 'POST',
            body: JSON.stringify({
                events: [
                    { eventId: 'c-nowait', occurredAt: '2026-08-03T02:00:00Z', featureKey: 'access-install', eventKey: 'access.command.copy' },
                ],
            }),
        })
    );
    assert.equal(res.status, 202);
    assert.equal(q.depth, 1, '事件应在队列中');
    assert.equal(st.events.size, 0, '响应返回时不应已落库');
});
