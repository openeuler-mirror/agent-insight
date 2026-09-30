import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import { createIsolatedDatabase } from './helpers/isolated-database';

test('computed trace filters preserve results while enriching only the requested page', async context => {
    const database = createIsolatedDatabase();
    const { PrismaClient } = await import('@prisma/client');
    const { executionBigIntToNumber } = await import('@/lib/storage/prisma-client');
    let enrichedRows = 0;
    let largestEvaluationLookup = 0;
    let largestCandidateBatch = 0;
    let executionRows = 0;
    let sqlRows = 0;
    const previousPrisma = (globalThis as any).prisma;
    (globalThis as any).prisma = new PrismaClient().$extends(executionBigIntToNumber).$extends({
        query: { async $allOperations({ model, operation, args, query }) {
            const result = await query(args);
            const lookup = args as any;
            if (operation === 'findMany') {
                if (model === 'Execution') {
                    largestCandidateBatch = Math.max(largestCandidateBatch, (result as any[]).length);
                    executionRows += (result as any[]).length;
                }
                if (model === 'ExecutionSkill') enrichedRows += lookup.where.executionId.in.length;
                if (model === 'TrajectoryEvalResult') largestEvaluationLookup = Math.max(largestEvaluationLookup, lookup.where.taskId.in.length);
            }
            if (operation === '$queryRaw') sqlRows += (result as any[]).length;
            return result;
        } },
    });
    const { prismaRaw } = await import('@/lib/storage/prisma');
    const { GET } = await import('@/app/api/observe/data/route');
    const { getTraceLifecycle } = await import('@/lib/observe/trace-lifecycle');
    const { calculateCost, getModelPricing } = await import('@/lib/shared/model-config');
    context.after(async () => { await prismaRaw.$disconnect(); (globalThis as any).prisma = previousPrisma; database.dispose(); });
    const count = 5_000;
    const now = Date.now();
    const executions = Array.from({ length: count }, (_, index) => ({
        id: `computed-${String(index).padStart(5, '0')}`,
        taskId: index % 499 === 0 ? null : `task-${index}`,
        user: 'computed-pagination', framework: index % 2 ? 'actrail' : 'pi-agent',
        query: `Trace ${index}`, agentName: index % 2 ? 'beta' : 'alpha',
        timestamp: new Date(now - 2_000_000 - Math.floor(index / 2) * 1_000),
        lastIngestedAt: new Date(now - (index % 5 >= 3 ? 30_000 : 2_000_000)),
        failures: JSON.stringify(index % 5 === 0 ? [{ failure_type: index % 2 ? 'agent-process-exit' : 'goal_plus_pi_session_failed' }] : []),
        latency: index % 11 ? index % 100 : null,
        toolCallCount: 10, toolCallErrorCount: index % 3,
        model: index % 29 ? 'gpt-4o' : index % 2 ? 'unknown-model' : null,
        inputTokens: index % 31 ? index % 23 : null, outputTokens: index % 17,
        cacheReadInputTokens: index % 7, cacheCreationInputTokens: index % 9,
        tokens: index % 40, cost: -index,
    }));
    const sessions = executions.flatMap((row, index) => index % 5 < 2 ? [{
        taskId: row.taskId || row.id, endTime: new Date(now - 1_000_000),
    }] : []);
    const anomalies = executions.flatMap((row, index) => index % 7 ? [] : [{
        taskId: index % 2 ? `unrelated-${index}` : row.taskId || row.id,
        executionId: index % 2 ? row.id : null,
        deliveryId: row.id, type: 'anomaly', payloadJson: '{}', ts: new Date(now),
    }]);
    for (let start = 0; start < count; start += 100) {
        await prismaRaw.execution.createMany({ data: executions.slice(start, start + 100) });
    }
    await prismaRaw.session.createMany({ data: sessions });
    await prismaRaw.rasAnomalyEvent.createMany({ data: anomalies });
    const completed = new Map(sessions.map(row => [row.taskId, row.endTime]));
    const pricing = getModelPricing('gpt-4o')!.pricing;
    const reference = executions.map((row, index) => ({
        ...row,
        status: getTraceLifecycle(completed.get(row.taskId || row.id), row, now).traceStatus,
        anomaly: index % 7 ? 'unknown' : 'abnormal',
        cost: row.model === 'gpt-4o' && row.inputTokens != null
            ? calculateCost(row.inputTokens, row.outputTokens, pricing, row.cacheReadInputTokens, row.cacheCreationInputTokens)
            : 0,
    }));
    const cases = [
        { status: 'failed', sort: 'timestamp', dir: 'desc', page: 2 },
        { status: 'timed_out', anomaly: 'abnormal', sort: 'tokens', dir: 'asc', page: 1 },
        { status: 'all', anomaly: 'unknown', sort: 'latency', dir: 'desc', page: 3 },
        { status: 'all', sort: 'status', dir: 'asc', page: 51 },
        { status: 'running', sort: 'agent', dir: 'asc', page: 2 },
        { status: 'all', sort: 'cost', dir: 'desc', page: 2 },
        { status: 'all', sort: 'cost', dir: 'asc', page: 1 },
        { status: 'all', anomaly: 'normal', sort: 'timestamp', dir: 'desc', page: 1 },
        { status: 'all', anomaly: 'detecting', sort: 'timestamp', dir: 'desc', page: 1 },
        { status: 'failed', sort: 'timestamp', dir: 'asc', page: 999 },
    ];
    const ranks = { running: 0, timed_out: 1, failed: 2, success: 3 };
    for (const input of cases) await context.test(JSON.stringify(input), async () => {
        enrichedRows = 0;
        largestEvaluationLookup = 0;
        largestCandidateBatch = 0;
        executionRows = 0;
        sqlRows = 0;
        const expected = reference.filter(row => (input.status === 'all' || input.status === row.status)
            && (!input.anomaly || input.anomaly === row.anomaly));
        expected.sort((a, b) => {
            let comparison = input.sort === 'status' ? ranks[a.status] - ranks[b.status]
                : input.sort === 'agent' ? a.agentName.localeCompare(b.agentName)
                    : input.sort === 'timestamp' ? +a.timestamp - +b.timestamp
                        : Number(a[input.sort as 'cost' | 'tokens' | 'latency'] ?? 0) - Number(b[input.sort as 'cost' | 'tokens' | 'latency'] ?? 0);
            comparison *= input.dir === 'asc' ? 1 : -1;
            return comparison || +b.timestamp - +a.timestamp || b.id.localeCompare(a.id);
        });
        const params = new URLSearchParams({ user: 'computed-pagination', fields: 'light', skipAutoEvalReady: '1', paginated: '1', databasePagination: '1', pageSize: '20', ...input, anomaly: input.anomaly ?? 'all', page: String(input.page) });
        const start = performance.now();
        const response = await GET(new Request(`http://localhost/api/observe/data?${params}`));
        const payload = await response.json();
        assert.equal(response.status, 200);
        assert.equal(payload.total, expected.length);
        assert.deepEqual(payload.records.map((row: any) => row.upload_id), expected.slice((input.page - 1) * 20, input.page * 20).map(row => row.id));
        assert.equal(payload.stats.failedCount, expected.filter(row => row.status === 'failed').length);
        assert.equal(payload.stats.avgLatencyMs, expected.length ? expected.reduce((sum, row) => sum + (row.latency ?? 0), 0) / expected.length : 0);
        console.log(`[computed-page] ${params.get('status')}/${input.anomaly || 'all'}/${input.sort}: ${Math.round(performance.now() - start)}ms; hydrated=${enrichedRows}; evaluationLookup=${largestEvaluationLookup}`);
        assert.ok(enrichedRows <= 20, `Only the requested page may be enriched, read ${enrichedRows} rows`);
        assert.ok(largestEvaluationLookup <= 20, `Evaluation queries must be limited to page rows, got ${largestEvaluationLookup}`);
        assert.ok(largestCandidateBatch <= 500, `Candidate reads must be bounded, got ${largestCandidateBatch}`);
        assert.ok(executionRows <= 20, `SQL filtering must not return off-page Execution candidates, got ${executionRows}`);
        assert.equal(sqlRows, payload.records.length + 1, 'SQL returns only page IDs and one aggregate row');
    });
    await context.test('computed and ordinary pages retain every Execution sharing a task ID', async () => {
        await prismaRaw.execution.createMany({ data: [
            { id: 'shared-task', taskId: 'shared-task', user: 'duplicate-pagination', timestamp: new Date(now) },
            { id: 'shared-task-copy', taskId: 'shared-task', user: 'duplicate-pagination', timestamp: new Date(now - 1) },
            { id: 'separate-task', taskId: 'separate-task', user: 'duplicate-pagination', timestamp: new Date(now - 2) },
        ] });
        for (const sort of ['timestamp', 'status']) {
            const response = await GET(new Request(`http://localhost/api/observe/data?user=duplicate-pagination&paginated=1&databasePagination=1&fields=light&skipAutoEvalReady=1&sort=${sort}`));
            const payload = await response.json();
            assert.equal(payload.total, 3);
            assert.equal(payload.records.length, 3);
            assert.equal(await prismaRaw.execution.count({ where: { user: 'duplicate-pagination' } }), 3);
        }
    });
    await context.test('all and subagent scopes retain correct totals across candidate batches', async () => {
        await prismaRaw.execution.createMany({ data: Array.from({ length: 1_001 }, (_, index) => ({
            id: `scope-subagent-${index}`, taskId: `scope-subagent-${index}`, user: 'computed-pagination',
            isSubagent: true, timestamp: new Date(now - index),
        })) });
        for (const [scope, expected] of [['', 5_000], ['includeSubagents=1', 6_001], ['onlySubagents=1', 1_001]] as const) {
            enrichedRows = 0;
            largestCandidateBatch = 0;
            const response = await GET(new Request(`http://localhost/api/observe/data?user=computed-pagination&paginated=1&databasePagination=1&fields=light&skipAutoEvalReady=1&sort=status&pageSize=20&${scope}`));
            const payload = await response.json();
            assert.equal(response.status, 200);
            assert.equal(payload.total, expected, scope);
            assert.ok(enrichedRows <= 20);
            assert.ok(largestCandidateBatch <= 500);
        }
    });
    await context.test('status filtering and response use one clock snapshot across the inactivity boundary', async () => {
        const snapshot = Date.now();
        const taskId = 'lifecycle-cutoff';
        await prismaRaw.execution.create({ data: {
            id: taskId, taskId, user: taskId, timestamp: new Date(snapshot - 599_999),
        } });
        const realNow = Date.now;
        const sessionFindMany = prismaRaw.session.findMany.bind(prismaRaw.session);
        Date.now = () => snapshot;
        prismaRaw.session.findMany = (async (args: any) => {
            const rows = await sessionFindMany(args);
            Date.now = () => snapshot + 2;
            return rows;
        }) as typeof prismaRaw.session.findMany;
        try {
            const response = await GET(new Request(`http://localhost/api/observe/data?user=${taskId}&status=running&paginated=1&databasePagination=1&fields=light&skipAutoEvalReady=1`));
            const payload = await response.json();
            assert.equal(response.status, 200);
            assert.equal(payload.total, 1);
            assert.equal(payload.records[0]?.trace_status, 'running');
        } finally {
            Date.now = realNow;
            prismaRaw.session.findMany = sessionFindMany;
        }
    });
});
