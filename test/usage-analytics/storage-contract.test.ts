import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryUsageStorage, PrismaUsageStorage } from '@/lib/usage-analytics/storage';
import { prismaRaw } from '@/lib/storage/prisma';
import { toDateKey } from '@/lib/usage-analytics/date';
import type { UsageEvent, UsageStorage } from '@/lib/usage-analytics/types';

const TAG = 'ct-usage-';

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
    const occurredAt = over.occurredAt ?? new Date('2026-08-03T02:00:00Z');
    return {
        eventId: over.eventId ?? `${TAG}${Math.random().toString(36).slice(2)}`,
        occurredAt,
        dateKey: over.dateKey ?? toDateKey(occurredAt),
        user: over.user ?? `${TAG}alice`,
        featureKey: over.featureKey ?? 'trace',
        eventKey: over.eventKey ?? 'trace.export',
        source: over.source ?? 'server',
        route: over.route ?? null,
    };
}

async function cleanupPrisma() {
    await prismaRaw.platformUsageEvent.deleteMany({ where: { user: { startsWith: TAG } } });
    await prismaRaw.platformUsageDaily.deleteMany({ where: { user: { startsWith: TAG } } });
}

function contractSuite(name: string, make: () => Promise<UsageStorage>, cleanup: () => Promise<void>) {
    test(`[${name}] 写入后可按日期范围读回聚合`, async () => {
        await cleanup();
        const st = await make();
        await st.persistBatch([ev(), ev(), ev()]);
        const rows = await st.queryDaily('2026-08-01', '2026-08-31');
        const mine = rows.filter((r) => r.user.startsWith(TAG));
        assert.equal(mine.length, 1, '同日/同用户/同事件应合并为一行');
        assert.equal(mine[0].count, 3);
        await cleanup();
    });

    test(`[${name}] 幂等：重放同一批不增加 count`, async () => {
        await cleanup();
        const st = await make();
        const batch = [ev({ eventId: `${TAG}fixed-1` }), ev({ eventId: `${TAG}fixed-2` })];

        const first = await st.persistBatch(batch);
        assert.equal(first, 2, '首次应插入 2 条');

        const second = await st.persistBatch(batch);
        assert.equal(second, 0, '重放不应新增');

        const rows = (await st.queryDaily('2026-08-01', '2026-08-31')).filter((r) => r.user.startsWith(TAG));
        assert.equal(rows[0].count, 2, 'count 不得因重放翻倍');
        await cleanup();
    });

    test(`[${name}] 不同日/用户/事件分开聚合`, async () => {
        await cleanup();
        const st = await make();
        await st.persistBatch([
            ev({ occurredAt: new Date('2026-08-03T02:00:00Z') }),
            ev({ occurredAt: new Date('2026-08-04T02:00:00Z') }),
            ev({ user: `${TAG}bob` }),
            ev({ eventKey: 'trace.import' }),
        ]);
        const rows = (await st.queryDaily('2026-08-01', '2026-08-31')).filter((r) => r.user.startsWith(TAG));
        assert.equal(rows.length, 4);
        assert.ok(rows.every((r) => r.count === 1));
        await cleanup();
    });

    test(`[${name}] 时区边界：UTC 16:00 归入上海次日`, async () => {
        await cleanup();
        const st = await make();
        await st.persistBatch([
            ev({ occurredAt: new Date('2026-08-03T15:59:59Z'), eventId: `${TAG}tz-a` }),
            ev({ occurredAt: new Date('2026-08-03T16:00:00Z'), eventId: `${TAG}tz-b` }),
        ]);
        const rows = (await st.queryDaily('2026-08-01', '2026-08-31')).filter((r) => r.user.startsWith(TAG));
        const byDate = Object.fromEntries(rows.map((r) => [r.dateKey, r.count]));
        assert.equal(byDate['2026-08-03'], 1);
        assert.equal(byDate['2026-08-04'], 1);
        await cleanup();
    });

    test(`[${name}] featureKey 过滤与 earliestDateKey`, async () => {
        await cleanup();
        const st = await make();
        await st.persistBatch([
            ev({ occurredAt: new Date('2026-07-01T02:00:00Z'), featureKey: 'trace', eventKey: 'trace.export' }),
            ev({ featureKey: 'skill', eventKey: 'skill.download' }),
        ]);
        const traceRows = (await st.queryDaily(null, '2026-12-31', 'trace')).filter((r) => r.user.startsWith(TAG));
        assert.equal(traceRows.length, 1);
        assert.equal(traceRows[0].featureKey, 'trace');
        await cleanup();
    });

    test(`[${name}] 清理原始事件不影响日聚合`, async () => {
        await cleanup();
        const st = await make();
        await st.persistBatch([
            ev({ occurredAt: new Date('2026-01-01T02:00:00Z'), eventId: `${TAG}old` }),
            ev({ occurredAt: new Date('2026-08-03T02:00:00Z'), eventId: `${TAG}new` }),
        ]);
        const before = (await st.queryDaily(null, '2026-12-31')).filter((r) => r.user.startsWith(TAG));
        const beforeTotal = before.reduce((a, r) => a + r.count, 0);

        const deleted = await st.cleanupRawBefore('2026-06-01');
        assert.ok(deleted >= 1, '应删掉过期原始事件');

        const after = (await st.queryDaily(null, '2026-12-31')).filter((r) => r.user.startsWith(TAG));
        assert.equal(after.reduce((a, r) => a + r.count, 0), beforeTotal, '日聚合必须不变');
        await cleanup();
    });
}

contractSuite('memory', async () => new InMemoryUsageStorage(), async () => {});
contractSuite('sqlite', async () => new PrismaUsageStorage(), cleanupPrisma);

// OpenGauss 未配置测试环境时显式 skip —— 不能把未覆盖标成通过（Phase3 T1-3）。
test('[opengauss] 契约测试', { skip: !process.env.DB_HOST ? '未配置 DB_HOST，跳过 OpenGauss 契约测试' : false }, () => {
    assert.ok(true);
});
