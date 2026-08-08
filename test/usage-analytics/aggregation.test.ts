import assert from 'node:assert/strict';
import test from 'node:test';

import { getUsageSummary, getUsageFeatureDetail, isValidRange } from '@/lib/usage-analytics/queries';
import { InMemoryUsageStorage } from '@/lib/usage-analytics/storage';
import { toDateKey } from '@/lib/usage-analytics/date';
import type { UsageEvent } from '@/lib/usage-analytics/types';

const NOW = new Date('2026-08-03T02:00:00Z'); // 上海 2026-08-03 10:00

function at(dateKey: string, over: Partial<UsageEvent> = {}): UsageEvent {
    const occurredAt = new Date(`${dateKey}T02:00:00Z`);
    return {
        eventId: over.eventId ?? Math.random().toString(36).slice(2),
        occurredAt,
        dateKey: over.dateKey ?? toDateKey(occurredAt),
        user: over.user ?? 'alice',
        featureKey: over.featureKey ?? 'trace',
        eventKey: over.eventKey ?? 'trace.export',
        source: 'server',
        route: null,
    };
}

async function seed(events: UsageEvent[]) {
    const st = new InMemoryUsageStorage();
    await st.persistBatch(events);
    return st;
}

test('range 校验只接受 7/30/90/all', () => {
    for (const r of ['7', '30', '90', 'all']) assert.equal(isValidRange(r), true);
    for (const r of ['1', '365', 'ALL', '', 'all ', null, 7]) assert.equal(isValidRange(r), false);
});

test('使用用户按去重计数，不是每日人数相加', async () => {
    const st = await seed([
        at('2026-08-01', { user: 'alice' }),
        at('2026-08-02', { user: 'alice' }),
        at('2026-08-03', { user: 'alice' }),
        at('2026-08-03', { user: 'bob' }),
    ]);
    const s = await getUsageSummary('7', NOW, st);
    assert.equal(s.kpis.users, 2, 'alice 出现 3 天仍只算 1 人');
    assert.equal(s.kpis.uses, 4);
});

test('功能行有效使用次数合计等于顶部有效使用次数', async () => {
    const st = await seed([
        at('2026-08-03', { featureKey: 'trace', eventKey: 'trace.export' }),
        at('2026-08-03', { featureKey: 'trace', eventKey: 'trace.import' }),
        at('2026-08-03', { featureKey: 'skill', eventKey: 'skill.download' }),
        at('2026-08-02', { featureKey: 'experiments', eventKey: 'experiment.run', user: 'bob' }),
    ]);
    const s = await getUsageSummary('7', NOW, st);
    const sum = s.features.reduce((a, f) => a + f.uses, 0);
    assert.equal(sum, s.kpis.uses, 'AC-007：功能行合计必须与顶部一致');
    assert.equal(s.kpis.uses, 4);
});

test('返回全部 16 个功能（无数据的为 0），且不含 dashboard/quality', async () => {
    const st = await seed([at('2026-08-03')]);
    const s = await getUsageSummary('7', NOW, st);
    assert.equal(s.features.length, 16);
    assert.ok(!s.features.some((f) => f.featureKey === 'dashboard'), 'Workspace 总览不得进入排行');
    assert.ok(!s.features.some((f) => f.featureKey === 'quality'), '质量监控（只读页）不得进入排行');
    assert.equal(s.features.find((f) => f.featureKey === 'trace')!.uses, 1);
    assert.equal(s.features.find((f) => f.featureKey === 'skill')!.uses, 0);
});

test('时间范围边界：7 天窗口排除第 8 天', async () => {
    const st = await seed([
        at('2026-08-03'),
        at('2026-07-28'), // 窗口内第 7 天
        at('2026-07-27'), // 窗口外
    ]);
    const s7 = await getUsageSummary('7', NOW, st);
    assert.equal(s7.from, '2026-07-28');
    assert.equal(s7.kpis.uses, 2);

    const s30 = await getUsageSummary('30', NOW, st);
    assert.equal(s30.kpis.uses, 3);
});

test('all 范围：from 取最早聚合日期，且不查询原始事件', async () => {
    const st = await seed([at('2025-01-15'), at('2026-08-03')]);
    // 清空原始事件明细，模拟保留期清理后
    st.events.clear();

    const s = await getUsageSummary('all', NOW, st);
    assert.equal(s.from, '2025-01-15');
    assert.equal(s.kpis.uses, 2, 'AC-008：清理原始事件后全部时间结果不变');
});

test('趋势逐日补零且点数等于自然日数', async () => {
    const st = await seed([at('2026-08-01'), at('2026-08-03'), at('2026-08-03')]);
    const s = await getUsageSummary('7', NOW, st);
    assert.equal(s.trend.length, 7);
    assert.equal(s.trend[s.trend.length - 1].date, '2026-08-03');
    const byDate = Object.fromEntries(s.trend.map((p) => [p.date, p.uses]));
    assert.equal(byDate['2026-08-01'], 1);
    assert.equal(byDate['2026-08-02'], 0, '无数据日应补零');
    assert.equal(byDate['2026-08-03'], 2);
});

test('功能详情：指标、趋势与使用行为构成', async () => {
    const st = await seed([
        at('2026-08-03', { featureKey: 'trace', eventKey: 'trace.export' }),
        at('2026-08-03', { featureKey: 'trace', eventKey: 'trace.export', user: 'bob' }),
        at('2026-08-02', { featureKey: 'trace', eventKey: 'trace.import' }),
        at('2026-08-03', { featureKey: 'skill', eventKey: 'skill.download' }),
    ]);
    const d = await getUsageFeatureDetail('trace', '7', NOW, st);
    assert.equal(d.label, '链路追踪');
    assert.equal(d.kpis.uses, 3, '不得混入其他功能的数据');
    assert.equal(d.kpis.users, 2);
    assert.deepEqual(
        d.behaviorBreakdown.map((b) => [b.eventKey, b.count]),
        [['trace.export', 2], ['trace.import', 1]]
    );
    assert.equal(d.behaviorBreakdown[0].label, '导出 Trace');
    assert.equal(d.trend.length, 7);
});

test('排序不改变合计与详情数据', async () => {
    const st = await seed([
        at('2026-08-03', { featureKey: 'trace' }),
        at('2026-08-03', { featureKey: 'skill', eventKey: 'skill.download' }),
    ]);
    const s = await getUsageSummary('7', NOW, st);
    const before = s.kpis.uses;
    // API 返回未排序完整集合；页面本地排序只重排展示
    const sorted = [...s.features].sort((a, b) => a.label.localeCompare(b.label));
    assert.equal(sorted.reduce((a, f) => a + f.uses, 0), before);
});
