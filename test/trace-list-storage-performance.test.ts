import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { executionBigIntToNumber } from '../src/lib/storage/prisma-client';

test('Trace list storage keeps work bounded and preserves lifecycle and agent facets', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-list-storage-'));
    const savedEnvironment = { ...process.env };
    delete process.env.DB_HOST;
    delete process.env.AGENT_INSIGHT_DATA_DIR;
    process.env.AGENT_INSIGHT_HOME = directory;
    process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`;
    fs.writeFileSync(path.join(directory, 'test.db'), '');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe' });

    const reads: Array<{ model: string; operation: string; rows: number }> = [];
    const client = new PrismaClient().$extends(executionBigIntToNumber).$extends({
        query: {
            async $allOperations({ model, operation, args, query }) {
                const result = await query(args);
                if (operation === 'findMany' || operation === 'groupBy' || operation === '$queryRaw') {
                    reads.push({ model: model || 'Raw', operation, rows: Array.isArray(result) ? result.length : 0 });
                }
                return result;
            },
        },
    });
    const globalWithPrisma = globalThis as typeof globalThis & { prisma?: unknown };
    const previousPrisma = globalWithPrisma.prisma;
    globalWithPrisma.prisma = client;
    const { listObservedAgentNames, readRecordPage } = await import('../src/lib/storage/data-service');
    context.after(async () => {
        await client.$disconnect();
        globalWithPrisma.prisma = previousPrisma;
        for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
        Object.assign(process.env, savedEnvironment);
        fs.rmSync(directory, { recursive: true, force: true });
    });

    await context.test('agent facet reads distinct name combinations and retains observed-only names', async () => {
        await client.execution.createMany({ data: Array.from({ length: 250 }, (_, index) => ({
            id: `facet-${index}`, user: 'facet-owner', agentName: 'main', observedAgents: '["worker","main","trace-quality-evaluator"]',
            timestamp: new Date(1_700_000_000_000 + index),
        })) });
        await client.execution.createMany({ data: [
            { id: 'facet-observed', user: 'facet-owner', agentName: null, observedAgents: '["legacy",null," ",4]', timestamp: new Date(1_700_000_001_000) },
            { id: 'facet-malformed', user: 'facet-owner', agentName: 'fallback', observedAgents: 'invalid', timestamp: new Date(1_700_000_002_000) },
            { id: 'facet-private', user: 'another-owner', agentName: 'private', timestamp: new Date(1_700_000_003_000) },
        ] });
        reads.length = 0;
        assert.deepEqual(await listObservedAgentNames('facet-owner', true), ['fallback', 'legacy', 'main', 'worker']);
        const executionRows = reads.filter(read => read.model === 'Execution').reduce((sum, read) => sum + read.rows, 0);
        assert.ok(executionRows <= 3, `facet loaded ${executionRows} rows for only three name combinations`);
        assert.deepEqual(await listObservedAgentNames('empty-owner', true), []);
    });

    await context.test('failed totals do not repeat the Execution scan for every 100 candidates', async () => {
        const failures = JSON.stringify([{ failure_type: 'agent-process-exit' }]);
        await client.execution.createMany({ data: Array.from({ length: 250 }, (_, index) => ({
            id: `failed-${index}`, taskId: `failed-${index}`, user: 'failed-owner', framework: 'actrail', failures,
            timestamp: new Date(1_700_000_000_000 + index),
        })) });
        await client.session.createMany({ data: Array.from({ length: 250 }, (_, index) => ({
            id: `session-${index}`, taskId: `failed-${index}`, endTime: new Date(1_700_000_001_000),
        })) });
        reads.length = 0;
        const result = await readRecordPage('failed-owner', undefined, {
            databasePagination: true, page: 1, pageSize: 1, lightweight: true, attachEvaluations: false,
        });
        assert.equal(result.records.length, 1);
        assert.equal(result.total, 250);
        assert.equal(result.stats.failedCount, 250);
        const executionReads = reads.filter(read => read.model === 'Execution' && read.operation === 'findMany');
        assert.ok(executionReads.length <= 2, `one page triggered ${executionReads.length} Execution reads`);
    });

    await context.test('large failed totals keep candidate batches bounded for root and all scopes', async () => {
        const count = 1_001;
        const failures = JSON.stringify([{ failure_type: 'agent-process-exit', description: 'x'.repeat(2_048) }]);
        await client.execution.createMany({ data: Array.from({ length: count }, (_, index) => ({
            id: `bounded-failed-${index}`, taskId: `bounded-failed-${index}`, user: 'bounded-failed-owner',
            framework: 'actrail', failures, isSubagent: index >= 750,
            timestamp: new Date(1_700_000_000_000 + Math.floor(index / 2)),
        })) });
        await client.session.createMany({ data: Array.from({ length: count }, (_, index) => ({
            id: `bounded-session-${index}`, taskId: `bounded-failed-${index}`, endTime: new Date(1_700_000_001_000),
        })) });
        for (const [filters, expected] of [[undefined, 750], [{ includeSubagents: true }, count], [{ onlySubagents: true }, 251]] as const) {
            reads.length = 0;
            const result = await readRecordPage('bounded-failed-owner', filters, {
                databasePagination: true, page: 1, pageSize: 1, lightweight: true, attachEvaluations: false,
            });
            assert.equal(result.total, expected);
            assert.equal(result.stats.failedCount, expected);
            const executionReads = reads.filter(read => read.model === 'Execution' && read.operation === 'findMany');
            const largest = Math.max(...executionReads.map(read => read.rows));
            assert.ok(largest <= 500, `Failed totals loaded ${largest} candidate rows in one batch`);
            assert.equal(executionReads.reduce((sum, read) => sum + read.rows, 0), 1, 'Only the requested page enters Node');
            assert.deepEqual(reads.filter(read => read.operation === '$queryRaw').map(read => read.rows), [1], 'All list statistics share one SQL aggregate');
        }
    });

    await context.test('failed totals require exact failure types and a positive session completion time', async () => {
        const processFailure = JSON.stringify([{ failure_type: 'agent-process-exit' }]);
        const goalFailure = JSON.stringify([{ failure_type: 'goal_plus_pi_session_failed' }]);
        const opencodeFailure = JSON.stringify([{ failure_type: 'opencode-session-error' }]);
        const cases = [
            { id: 'process', framework: 'actrail', failures: processFailure, endTime: 1, expected: true },
            { id: 'goal', framework: 'pi-agent', failures: goalFailure, endTime: 1, expected: true },
            { id: 'goal-other-framework', framework: 'opencode', failures: goalFailure, endTime: 1, expected: true },
            { id: 'process-other-framework', framework: 'opencode', failures: processFailure, endTime: 1, expected: false },
            { id: 'opencode', framework: 'opencode', failures: opencodeFailure, endTime: 1, expected: true },
            { id: 'opencode-other-framework', framework: 'actrail', failures: opencodeFailure, endTime: 1, expected: false },
            { id: 'opencode-unfinished', framework: 'opencode', failures: opencodeFailure, endTime: null, expected: false },
            { id: 'opencode-description-only', framework: 'opencode', failures: '[{"description":"opencode-session-error"}]', endTime: 1, expected: false },
            { id: 'missing-session', framework: 'actrail', failures: processFailure, expected: false },
            { id: 'unfinished', framework: 'actrail', failures: processFailure, endTime: null, expected: false },
            { id: 'epoch', framework: 'actrail', failures: processFailure, endTime: 0, expected: false },
            { id: 'negative', framework: 'actrail', failures: processFailure, endTime: -1, expected: false },
            { id: 'malformed', framework: 'actrail', failures: '[{"failure_type":"agent-process-exit"}', endTime: 1, expected: false },
            { id: 'object', framework: 'actrail', failures: '{"failure_type":"agent-process-exit"}', endTime: 1, expected: false },
            { id: 'wrong-field', framework: 'actrail', failures: '[{"description":"agent-process-exit"}]', endTime: 1, expected: false },
            { id: 'array-values', framework: 'actrail', failures: '[null,4,"agent-process-exit"]', endTime: 1, expected: false },
            { id: 'case-sensitive', framework: 'actrail', failures: '[{"failure_type":"AGENT-PROCESS-EXIT"}]', endTime: 1, expected: false },
            { id: 'null-task', taskId: null, framework: 'actrail', failures: processFailure, endTime: 1, expected: true },
            { id: 'empty-task', taskId: '', framework: 'pi-agent', failures: goalFailure, endTime: 1, expected: true },
        ];
        for (const item of cases) {
            const id = `semantics-${item.id}`;
            const taskId = 'taskId' in item ? item.taskId : id;
            await client.execution.create({ data: {
                id, taskId, framework: item.framework, failures: item.failures, user: 'semantics-owner', timestamp: new Date(1),
            } });
            if ('endTime' in item) await client.session.create({ data: {
                id, taskId: taskId || id, endTime: item.endTime == null ? null : new Date(item.endTime),
            } });
        }
        await client.execution.create({ data: {
            id: 'semantics-first-page', user: 'semantics-owner', timestamp: new Date(2),
        } });
        const result = await readRecordPage('semantics-owner', undefined, {
            databasePagination: true, page: 1, pageSize: 1, lightweight: true, attachEvaluations: false,
        });
        assert.equal(result.total, cases.length + 1);
        assert.equal(result.stats.failedCount, cases.filter(item => item.expected).length);
    });
});
