import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Prisma } from '@prisma/client';
import { createIsolatedDatabase } from './helpers/isolated-database';

test('Trace SQL matches Prisma filters and established lifecycle, pricing, and statistics', async context => {
    const database = createIsolatedDatabase();
    const originalDirectory = process.cwd();
    process.chdir(database.home);
    fs.writeFileSync(path.join(database.home, 'custom-models.json'), JSON.stringify({
        'gpt-4o': { inputTokenPrice: 7, outputTokenPrice: 13 },
        'gpt-4o-mini': { inputTokenPrice: 2, outputTokenPrice: 3, cacheReadInputTokenPrice: 0.5, cacheCreationInputTokenPrice: 5 },
    }));
    const { prismaRaw } = await import('@/lib/storage/prisma');
    context.after(async () => {
        await prismaRaw.$disconnect();
        process.chdir(originalDirectory);
        database.dispose();
    });
    const { compileExecutionWhere, aggregateExecutionList } = await import('@/lib/storage/execution-list-sql');
    const { selectComputedRecordPage } = await import('@/lib/storage/computed-record-page');
    const { getTraceLifecycle } = await import('@/lib/observe/trace-lifecycle');
    const { getModelPricing, calculateCost, writeCustomModels } = await import('@/lib/shared/model-config');
    const snapshot = 1_800_000_000_000;
    const owner = "owner'; DROP TABLE Execution; --";
    const attack = "x' OR 1=1 --";
    const definitions: Array<{
        id: string; taskId?: string | null; query: string | null; framework?: string | null;
        failures?: string | null; endTime?: number | null; timestamp?: number; lastReceived?: number | null;
        agentName?: string | null; model?: string | null; inputTokens?: number | null;
    }> = [
        { id: 'a-null', query: null, taskId: null, timestamp: 0, lastReceived: null },
        { id: 'B-empty', query: '', taskId: '', timestamp: -1, lastReceived: 0 },
        { id: 'c-timeout', query: 'Alpha 100%', lastReceived: snapshot - 600_000, agentName: 'Alpha' },
        { id: 'd-running', query: 'alpha_thing', lastReceived: snapshot - 599_999, agentName: 'alpha' },
        { id: 'e-process-failed', query: 'alpha\\thing', framework: 'actrail', failures: '[{"failure_type":"agent-process-exit"}]', endTime: 1 },
        { id: 'f-goal-failed', query: attack, framework: 'opencode', failures: '[{"failure_type":"goal_plus_pi_session_failed"}]', endTime: 1 },
        { id: 'g-process-other-framework', query: '汉字', agentName: '汉字', framework: 'opencode', failures: '[{"failure_type":"agent-process-exit"}]', endTime: 1 },
        { id: 'h-description-only', query: '%_', agentName: '', framework: 'actrail', failures: '[{"description":"agent-process-exit"}]', endTime: 1 },
        { id: 'i-invalid-json', query: 'line\nbreak', framework: 'actrail', failures: '[{"failure_type":"agent-process-exit"}', endTime: 1 },
        { id: 'j-object-json', query: "O'Reilly", framework: 'actrail', failures: '{"failure_type":"agent-process-exit"}', endTime: 1 },
        { id: 'k-nonobject-array', query: 'tail%', failures: '[null,4,"goal_plus_pi_session_failed"]', endTime: 1 },
        { id: 'l-epoch-end', query: '_prefix', failures: '[{"failure_type":"goal_plus_pi_session_failed"}]', endTime: 0 },
        { id: 'm-negative-end', query: 'slashes\\_', endTime: -1, timestamp: 1, lastReceived: null },
        { id: 'n-no-session', query: 'Alpha', failures: '[{"failure_type":"goal_plus_pi_session_failed"}]', lastReceived: snapshot - 600_001 },
        { id: 'o-null-end', query: 'tail', endTime: null, model: 'unknown-model' },
        { id: 'p-null-input', query: 'ALPHA', inputTokens: null, model: 'gpt-4o-mini-version' },
        { id: 'q-shared-a', query: 'shared', taskId: 'shared-task', endTime: 100, agentName: 'same' },
        { id: 'r-shared-b', query: 'shared', taskId: 'shared-task', agentName: 'same' },
        { id: 's-opencode-failed', query: 'OpenCode error', framework: 'opencode', failures: '[{"failure_type":"opencode-session-error"}]', endTime: 1 },
        { id: 't-opencode-running', query: 'OpenCode active', framework: 'opencode', failures: '[{"failure_type":"opencode-session-error"}]' },
        { id: 'u-opencode-timeout', query: 'OpenCode timeout', framework: 'opencode', failures: '[{"failure_type":"opencode-session-error"}]', endTime: 0, lastReceived: snapshot - 600_000 },
        { id: 'v-opencode-other-framework', query: 'Other framework', framework: 'actrail', failures: '[{"failure_type":"opencode-session-error"}]', endTime: 1 },
        { id: 'w-opencode-description-only', query: 'Description only', framework: 'opencode', failures: '[{"description":"opencode-session-error"}]', endTime: 1 },
        { id: 'x-opencode-invalid-json', query: 'Invalid error JSON', framework: 'opencode', failures: '[{"failure_type":"opencode-session-error"}', endTime: 1 },
    ];
    const rows = definitions.map((definition, index) => ({
        id: definition.id,
        taskId: 'taskId' in definition ? definition.taskId : `task-${definition.id}`,
        user: owner, query: definition.query, finalResult: index % 2 ? 'completed' : null,
        framework: definition.framework ?? (index % 2 ? 'opencode' : null),
        agentName: definition.agentName ?? (index % 3 ? 'worker' : null),
        isSubagent: index % 3 === 0,
        parentExecutionId: index % 3 === 0 ? 'parent' : null,
        timestamp: new Date(definition.timestamp ?? snapshot - 900_000 - Math.floor(index / 2)),
        lastIngestedAt: definition.lastReceived === null ? null : new Date(definition.lastReceived ?? snapshot - 1),
        failures: definition.failures ?? null,
        model: definition.model ?? (index % 2 ? 'gpt-4o-mini-version' : 'gpt-4o-version'),
        inputTokens: 'inputTokens' in definition ? definition.inputTokens : index % 2 ? 0 : 5_000_000_000 + index,
        outputTokens: index * 1_000,
        cacheReadInputTokens: index % 2 ? null : 100,
        cacheCreationInputTokens: index % 3 ? 0 : 50,
        cost: -1000 - index,
        tokens: index % 2 ? 0 : 5_000_000_000 + index,
        latency: index % 3 ? index * 10 : null,
        toolCallCount: index % 4 ? index : null,
        toolCallErrorCount: index % 3 ? 1 : null,
        skillVersion: index % 3 ? index : null,
        observedAgents: index % 2 ? '["worker","agent_%"]' : null,
    }));
    await prismaRaw.execution.createMany({ data: rows });
    await prismaRaw.execution.create({ data: { id: 'outside-owner', user: 'someone-else', query: attack, timestamp: new Date(snapshot) } });
    const sessions = definitions.flatMap((definition, index) => 'endTime' in definition ? [{
        taskId: rows[index].taskId || rows[index].id,
        endTime: definition.endTime == null ? null : new Date(definition.endTime),
    }] : []);
    await prismaRaw.session.createMany({ data: sessions });
    const taskAnomaly = rows[3];
    const executionAnomaly = rows[4];
    await prismaRaw.rasAnomalyEvent.createMany({ data: [
        { taskId: taskAnomaly.taskId || taskAnomaly.id, deliveryId: 'by-task', type: 'anomaly', payloadJson: '{}', ts: new Date(snapshot) },
        { taskId: 'unrelated-task', executionId: executionAnomaly.id, deliveryId: 'by-execution', type: 'anomaly', payloadJson: '{}', ts: new Date(snapshot) },
    ] });

    const filterCases: Array<[string, Prisma.ExecutionWhereInput]> = [
        ['empty object', {}], ['empty AND', { AND: [] }], ['empty OR', { OR: [] }], ['empty NOT', { NOT: [] }],
        ['OR empty object', { OR: [{}] }], ['AND empty object', { AND: [{}] }],
        ['NOT empty object', { NOT: {} }], ['NOT array empty object', { NOT: [{}] }],
        ['OR empty object and value', { OR: [{}, { query: 'Alpha' }] }],
        ['AND empty object and value', { AND: [{}, { query: 'Alpha' }] }],
        ['NOT empty object and value', { NOT: [{}, { query: 'Alpha' }] }],
        ['OR empty field filter', { OR: [{ query: {} }] }],
        ['OR undefined field filter', { OR: [{ query: { equals: undefined } }] }],
        ['NOT empty OR', { NOT: { OR: [] } }],
        ['OR empty NOT and value', { OR: [{ NOT: [] }, { query: 'Alpha' }] }],
        ['AND empty OR and value', { AND: [{ OR: [] }, { query: 'Alpha' }] }],
        ['AND only empty OR', { AND: [{ OR: [] }] }],
        ['AND empty OR and empty object', { AND: [{ OR: [] }, {}] }],
        ['AND object empty OR', { AND: { OR: [] } }],
        ['OR nested empty OR', { OR: [{ OR: [] }] }],
        ['value alongside root empty OR', { query: 'Alpha', OR: [] }],
        ['AND nested value alongside empty OR', { AND: [{ query: 'Alpha', OR: [] }] }],
        ['OR nested value alongside empty OR', { OR: [{ query: 'Alpha', OR: [] }] }],
        ['NOT nested value alongside empty OR', { NOT: { query: 'Alpha', OR: [] } }],
        ['AND nested empty OR alongside NOT', { AND: [{ OR: [], NOT: { query: 'Alpha' } }] }],
        ['AND OR empty object and value', { AND: [{ OR: [{}] }, { query: 'Alpha' }] }],
        ['AND OR empty scalar alongside value', { AND: [{ OR: [{ query: {} }], query: 'Alpha' }] }],
        ['OR NOT empty OR and value', { OR: [{ NOT: { OR: [] } }, { query: 'Alpha' }] }],
        ['AND NOT empty OR and value', { AND: [{ NOT: { OR: [] } }, { query: 'Alpha' }] }],
        ['OR AND empty OR and values', { OR: [{ AND: [{ OR: [] }, { query: 'Alpha' }] }, { query: 'tail' }] }],
        ['AND empty IN remains false', { AND: [{ query: { in: [] } }, { query: 'Alpha' }] }],
        ['NOT empty scalar filter', { NOT: { query: {} } }],
        ['NOT scalar empty NOT', { query: { not: {} } }],
        ['nested empty objects', { OR: [{ AND: [] }, { NOT: {} }] }],
        ['exact injected owner', { user: owner }], ['exact injected input', { query: attack }],
        ['null equality', { query: null }], ['null equals', { query: { equals: null } }],
        ['not null', { query: { not: null } }], ['not scalar excludes null', { query: { not: 'Alpha' } }],
        ['nested not', { query: { not: { not: 'Alpha' } } }],
        ['nested not equals', { query: { not: { equals: 'Alpha' } } }],
        ['nested not null', { query: { not: { not: null } } }],
        ['triple nested not', { query: { not: { not: { not: 'Alpha' } } } }],
        ['nested not membership', { query: { not: { in: ['Alpha', attack] } } }],
        ['nested not multiple operators', { query: { not: { startsWith: 'alpha', endsWith: 'thing' } } }],
        ['NOT multiple operator field', { NOT: { query: { startsWith: 'alpha', endsWith: 'thing' } } }],
        ['empty IN', { query: { in: [] } }], ['empty NOT IN', { query: { notIn: [] } }],
        ['null IN', { query: { in: null } }], ['null NOT IN', { query: { notIn: null } }],
        ['IN values', { query: { in: [attack, "O'Reilly", 'Alpha'] } }],
        ['NOT IN values', { query: { notIn: [attack, 'Alpha'] } }],
        ['AND one object', { AND: { user: owner, isSubagent: false } }],
        ['NOT one object with two fields', { NOT: { query: 'Alpha', agentName: 'worker' } }],
        ['NOT nested boolean NOT', { NOT: { NOT: { query: 'Alpha' } } }],
        ['NOT field with two numeric operators', { skillVersion: { not: { gt: 2, lt: 13 } } }],
        ['NOT array', { NOT: [{ query: 'Alpha' }, { agentName: 'worker' }] }],
        ['nested boolean filters', { AND: [{ OR: [{ query: null }, { query: { contains: 'alpha' } }] }, { NOT: { OR: [{ isSubagent: true }, { taskId: '' }] } }] }],
        ['nullable negative with explicit null branch', { OR: [{ query: { notIn: ['Alpha'] } }, { query: null }] }],
        ['boolean true', { isSubagent: true }], ['boolean false', { isSubagent: false }],
        ['numeric range', { skillVersion: { gt: 2, lte: 13 } }],
        ['bigint range', { tokens: { gte: 5_000_000_000, lt: 5_000_000_010 } }],
        ['timestamp milliseconds', { timestamp: { gte: new Date(-1), lt: new Date(2) } }],
        ['timestamp equality', { timestamp: new Date(0) }],
        ['timestamp ISO string equality', { timestamp: new Date(0).toISOString() }],
        ['timestamp ISO string range', { timestamp: { gte: new Date(-1).toISOString(), lt: new Date(2).toISOString() } }],
        ['timestamp ISO string membership', { timestamp: { in: [new Date(0).toISOString(), new Date(-1).toISOString()] } }],
        ['absent optional field', { user: undefined, query: { equals: undefined } }],
    ];
    for (const operator of ['contains', 'startsWith', 'endsWith'] as const) {
        for (const value of ['alpha', '%', '_', '\\', '\\_', attack, '汉']) {
            filterCases.push([`${operator} ${JSON.stringify(value)}`, { query: { [operator]: value } }]);
        }
    }
    for (const [name, where] of filterCases) await context.test(`SQL predicate matches Prisma: ${name}`, async () => {
        const expected = await prismaRaw.execution.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
        const predicate = compileExecutionWhere(where);
        const actual = await prismaRaw.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT e.id FROM Execution e WHERE ${predicate} ORDER BY e.id`);
        assert.deepEqual(actual.map(row => row.id), expected.map(row => row.id));
    });

    await context.test('all untrusted values are parameters and unknown identifiers fail closed', async () => {
        const predicate = compileExecutionWhere({ user: owner, OR: [{ query: { contains: attack } }, { taskId: { in: [attack] } }] });
        assert.equal(predicate.sql.includes(owner), false);
        assert.equal(predicate.sql.includes(attack), false);
        assert.ok(predicate.values.some(value => value === owner));
        assert.ok(predicate.values.some(value => typeof value === 'string' && value.includes(attack)));
        for (const where of [
            { 'id) OR 1=1 --': attack },
            { query: { 'equals) OR 1=1 --': attack } },
            { query: { mode: 'insensitive' } },
            { evaluations: { some: {} } },
        ]) assert.throws(() => compileExecutionWhere(where as Prisma.ExecutionWhereInput));
        assert.equal(await prismaRaw.execution.count(), rows.length + 1);
    });

    const completed = new Map(sessions.map(session => [session.taskId, session.endTime]));
    const abnormal = new Set([taskAnomaly.id, executionAnomaly.id]);
    const statusRanks = { running: 0, timed_out: 1, failed: 2, success: 3 };
    await context.test('OpenCode error filtering, status ordering and aggregate match completed-session semantics', async () => {
        const ids = definitions.slice(-6).map(row => row.id);
        const where = { user: owner, id: { in: ids } };
        const options = { anomaly: 'all' as const, sortKey: 'status' as const, sortDir: 'asc' as const, page: 1, pageSize: 20, lifecycleNow: snapshot };
        const failed = await selectComputedRecordPage(where, { ...options, status: 'failed' });
        assert.deepEqual(failed.ids, ['s-opencode-failed']);
        assert.equal(failed.total, 1);
        assert.equal(failed.stats.failedCount, 1);
        const all = await selectComputedRecordPage(where, { ...options, status: 'all' });
        assert.deepEqual(all.ids, ['t-opencode-running', 'u-opencode-timeout', 's-opencode-failed', 'v-opencode-other-framework', 'x-opencode-invalid-json', 'w-opencode-description-only']);
        assert.equal((await aggregateExecutionList(where)).failedCount, 1);
    });
    function referenceCost(row: typeof rows[number]) {
        const pricing = row.model ? getModelPricing(row.model)?.pricing : undefined;
        return pricing && row.inputTokens != null && row.outputTokens != null
            ? calculateCost(row.inputTokens, row.outputTokens, pricing, row.cacheReadInputTokens ?? undefined, row.cacheCreationInputTokens ?? undefined)
            : 0;
    }
    for (const sortDir of ['asc', 'desc'] as const) await context.test(`computed agentName uses SQLite ordering with timestamp/id ties: ${sortDir}`, async () => {
        const where = { user: owner };
        const expected = await prismaRaw.execution.findMany({ where, select: { id: true }, orderBy: [{ agentName: sortDir }, { timestamp: 'desc' }, { id: 'desc' }] });
        const actual = await selectComputedRecordPage(where, { status: 'all', anomaly: 'all', sortKey: 'agentName', sortDir, page: 1, pageSize: 100, lifecycleNow: snapshot });
        assert.deepEqual(actual.ids, expected.map(row => row.id));
    });
    for (const [name, where] of [
        ['all roots and children', { user: owner }],
        ['roots', { user: owner, isSubagent: false }],
        ['missing records', { user: owner, id: 'does-not-exist' }],
        ['nullable latency only', { user: owner, latency: null }],
        ['nullable latency excluded', { user: owner, latency: { not: null } }],
        ['nested predicate', { user: owner, OR: [{ query: null }, { query: { contains: 'alpha' } }] }],
    ] as Array<[string, Prisma.ExecutionWhereInput]>) await context.test(`SQL ordinary aggregate matches Prisma and lifecycle: ${name}`, async () => {
        const expected = await prismaRaw.execution.aggregate({ where, _count: true, _avg: { latency: true }, _sum: { toolCallCount: true, toolCallErrorCount: true } });
        const selectedIds = new Set((await prismaRaw.execution.findMany({ where, select: { id: true } })).map(row => row.id));
        const selected = rows.filter(row => selectedIds.has(row.id));
        const failedCount = selected.filter(row => getTraceLifecycle(completed.get(row.taskId || row.id), row, snapshot).traceStatus === 'failed').length;
        const totalTools = Number(expected._sum.toolCallCount ?? 0);
        const totalErrors = Number(expected._sum.toolCallErrorCount ?? 0);
        const actual = await aggregateExecutionList(where, { lifecycleNow: snapshot });
        assert.deepEqual({ ...actual, avgLatencyMs: undefined }, {
            total: expected._count, failedCount, avgLatencyMs: undefined,
            toolErrorRate: totalTools ? Math.round(totalErrors / totalTools * 1000) / 10 : 0,
        });
        assert.ok(Math.abs(actual.avgLatencyMs - (expected._avg.latency ?? 0)) <= Math.max(1, actual.avgLatencyMs) * Number.EPSILON * 2);
        const computed = await selectComputedRecordPage(where, { status: 'all', anomaly: 'all', sortKey: 'timestamp', sortDir: 'desc', page: 1, pageSize: 100, lifecycleNow: snapshot });
        assert.equal(computed.total, actual.total);
        assert.equal(computed.stats.failedCount, actual.failedCount);
        assert.equal(computed.stats.toolErrorRate, actual.toolErrorRate);
        assert.deepEqual(computed.stats, await aggregateExecutionList(where, { lifecycleNow: snapshot, avgNullAsZero: true }));
    });
    for (const status of ['all', 'running', 'timed_out', 'failed', 'success']) {
        for (const sortKey of ['timestamp', 'cost', 'status'] as const) await context.test(`SQL computed semantics: ${status}/${sortKey}`, async () => {
            const selected = rows.map(row => ({ ...row, lifecycle: getTraceLifecycle(completed.get(row.taskId || row.id), row, snapshot).traceStatus }));
            const expected = selected.filter(row => status === 'all' || row.lifecycle === status);
            expected.sort((a, b) => {
                const value = sortKey === 'status' ? statusRanks[b.lifecycle] - statusRanks[a.lifecycle]
                    : sortKey === 'cost' ? referenceCost(b) - referenceCost(a) : +b.timestamp - +a.timestamp;
                return value || +b.timestamp - +a.timestamp || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
            });
            const actual = await selectComputedRecordPage({ user: owner }, { status, anomaly: 'all', sortKey, sortDir: 'desc', page: 1, pageSize: 100, lifecycleNow: snapshot });
            assert.deepEqual(actual.ids, expected.map(row => row.id));
            assert.equal(actual.total, expected.length);
            assert.equal(actual.stats.failedCount, expected.filter(row => row.lifecycle === 'failed').length);
            assert.equal(actual.stats.avgLatencyMs, expected.length ? expected.reduce((sum, row) => sum + (row.latency ?? 0), 0) / expected.length : 0);
            const tools = expected.reduce((sum, row) => sum + (row.toolCallCount ?? 0), 0);
            const errors = expected.reduce((sum, row) => sum + (row.toolCallErrorCount ?? 0), 0);
            assert.equal(actual.stats.toolErrorRate, tools ? Math.round(errors / tools * 1000) / 10 : 0);
        });
    }
    for (const anomaly of ['abnormal', 'unknown', 'normal', 'detecting'] as const) await context.test(`SQL anomaly semantics: ${anomaly}`, async () => {
        const expected = rows.filter(row => anomaly === 'abnormal' ? abnormal.has(row.id) : anomaly === 'unknown' ? !abnormal.has(row.id) : false);
        const actual = await selectComputedRecordPage({ user: owner }, { status: 'all', anomaly, sortKey: 'timestamp', sortDir: 'desc', page: 1, pageSize: 100, lifecycleNow: snapshot });
        assert.equal(actual.total, expected.length);
        assert.deepEqual([...actual.ids].sort(), expected.map(row => row.id).sort());
    });
    await context.test('updated custom pricing takes effect on the next SQL cost query', async () => {
        writeCustomModels({
            'gpt-4o': { inputTokenPrice: 0.0001, outputTokenPrice: 0.0001 },
            'gpt-4o-mini': { inputTokenPrice: 10000, outputTokenPrice: 10000, cacheReadInputTokenPrice: 10000, cacheCreationInputTokenPrice: 10000 },
        });
        const expected = [...rows].sort((a, b) => referenceCost(b) - referenceCost(a) || +b.timestamp - +a.timestamp || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const actual = await selectComputedRecordPage({ user: owner }, { status: 'all', anomaly: 'all', sortKey: 'cost', sortDir: 'desc', page: 1, pageSize: 5, lifecycleNow: snapshot });
        assert.deepEqual(actual.ids, expected.slice(0, 5).map(row => row.id));
    });
});
