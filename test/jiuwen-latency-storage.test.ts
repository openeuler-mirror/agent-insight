/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { repairTraceLatency } from '@/lib/storage/repair-trace-latency';
import { executionBigIntToNumber } from '@/lib/storage/prisma-client';
import { TRACE_BUNDLE_FORMAT, TRACE_BUNDLE_VERSION, type TraceBundleV1 } from '@/lib/trace-transfer';

test('Jiuwen legacy import and history correction preserve source data and are idempotent', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jiuwen-latency-'));
    const previousEnvironment = { ...process.env };
    delete process.env.DB_HOST;
    delete process.env.AGENT_INSIGHT_DATA_DIR;
    process.env.AGENT_INSIGHT_HOME = directory;
    process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`;
    fs.writeFileSync(path.join(directory, 'test.db'), '');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
    const client = new PrismaClient();
    const globalClient = globalThis as typeof globalThis & { prisma?: unknown };
    const previousClient = globalClient.prisma;
    globalClient.prisma = client.$extends(executionBigIntToNumber);
    context.after(async () => {
        await client.$disconnect();
        globalClient.prisma = previousClient;
        for (const key of Object.keys(process.env)) if (!(key in previousEnvironment)) delete process.env[key];
        Object.assign(process.env, previousEnvironment);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const { importTraceBundle } = await import('@/lib/trace-transfer-service');
    const base = Date.parse('2026-06-24T08:20:54.710Z');
    const interactions = [{ role: 'assistant', content: 'historical trace',
        timeInfo: { created: base, completed: base + 61_183_862 } }];
    const bundle = (id: string, latency: number, events = interactions, framework = 'jiuwenswarm'): TraceBundleV1 => ({
        format: TRACE_BUNDLE_FORMAT, version: TRACE_BUNDLE_VERSION,
        exportedAt: new Date(base).toISOString(), rootExecutionId: id,
        executions: [{ execution: {
            id, taskId: id, query: 'unit regression', framework, tokens: 10, cost: null, latency,
            toolCallCount: 0, llmCallCount: 1, inputTokens: 5, outputTokens: 5, toolCallErrorCount: 0,
            cacheReadInputTokens: null, cacheCreationInputTokens: null, maxSingleCallTokens: null,
            reasoningTokens: null, timestamp: new Date(base).toISOString(), model: null, endpoint: null,
            agentName: 'leader', finalResult: 'done', skill: null, skills: [], invokedSkills: [],
            skillVersion: null, label: null, observedAgents: [], parentExecutionId: null,
            rootExecutionId: null, agentSessionId: null, subagentType: null, subagentName: null, isSubagent: false,
        }, session: { taskId: id, label: null, query: 'unit regression', startTime: new Date(base).toISOString(),
            endTime: new Date(base + 61_183_862).toISOString(), interactions: events, model: null } }],
    });

    const oldBundle = bundle('import-legacy', 61_187.865);
    const originalBundle = structuredClone(oldBundle);
    await importTraceBundle(oldBundle, 'unit-test');
    assert.equal((await client.execution.findUniqueOrThrow({ where: { id: 'import-legacy' } })).latency, 61_187_865);
    assert.deepEqual(oldBundle, originalBundle, 'import must not mutate the supplied bundle');
    for (const [id, value, events, framework] of [
        ['already-ms', 61_187_865, interactions, 'jiuwenswarm'],
        ['already-short-ms', 0.001, [{ role: 'assistant', content: 'short', timeInfo: { created: 0, completed: 0.001 } }], 'jiuwenswarm'],
        ['quantized-short-ms', 0.002, [{ role: 'assistant', content: 'short', timeInfo: { created: 1, completed: 2 } }], 'jiuwenswarm'],
        ['untimed-import', 61_187.865, [], 'jiuwenswarm'],
        ['other-framework', 61_187.865, interactions, 'codex'],
    ] as const) {
        await importTraceBundle(bundle(id, value, [...events], framework), 'unit-test');
        assert.equal((await client.execution.findUniqueOrThrow({ where: { id } })).latency, value);
    }
    await client.execution.create({ data: { id: 'old-history', taskId: 'old-history', framework: 'jiuwenswarm', latency: 61_187.865 } });
    await client.session.create({ data: { taskId: 'old-history', interactions: JSON.stringify(interactions) } });
    const before = await client.execution.findUniqueOrThrow({ where: { id: 'old-history' } });
    const sessionBefore = await client.session.findUniqueOrThrow({ where: { taskId: 'old-history' } });
    const preview = await repairTraceLatency(client, { framework: 'jiuwenswarm' });
    assert.equal(preview.changed, 1);
    assert.equal((await client.execution.findUniqueOrThrow({ where: { id: 'old-history' } })).latency, 61_187.865);
    const applied = await repairTraceLatency(client, { framework: 'jiuwenswarm', apply: true });
    assert.equal(applied.updated, 1);
    assert.deepEqual(applied.changes, [{ id: 'old-history', taskId: 'old-history', originalLatency: 61_187.865, latencyMs: 61_187_865 }]);
    assert.deepEqual(await client.execution.findUniqueOrThrow({ where: { id: 'old-history' } }), { ...before, latency: 61_187_865 });
    assert.deepEqual(await client.session.findUniqueOrThrow({ where: { taskId: 'old-history' } }), sessionBefore);
    assert.equal((await repairTraceLatency(client, { framework: 'jiuwenswarm', apply: true })).changed, 0);

    for (const mutation of ['session', 'framework']) {
        const id = `race-${mutation}`;
        await client.execution.create({ data: { id, taskId: id, framework: 'jiuwenswarm', latency: 61_187.865 } });
        await client.session.create({ data: { taskId: id, interactions: JSON.stringify(interactions) } });
        const racingClient = new Proxy(client, {
            get(target, key) {
                if (key === '$transaction') return async (action: any) => {
                    if (mutation === 'session') await client.session.update({ where: { taskId: id }, data: { interactions: '[]' } });
                    else await client.execution.update({ where: { id }, data: { framework: 'codex' } });
                    return target.$transaction(action);
                };
                return Reflect.get(target, key);
            },
        });
        const raced = await repairTraceLatency(racingClient, { framework: 'jiuwenswarm', apply: true, taskIds: [id] });
        assert.equal(raced.conflicts, 1);
        assert.equal(raced.updated, 0);
        assert.equal((await client.execution.findUniqueOrThrow({ where: { id } })).latency, 61_187.865);
    }

    for (const id of ['audit-a', 'audit-b']) {
        await client.execution.create({ data: { id, taskId: id, framework: 'jiuwenswarm', latency: 61_187.865 } });
        await client.session.create({ data: { taskId: id, interactions: JSON.stringify(interactions) } });
    }
    await client.$executeRawUnsafe(`CREATE TRIGGER reject_second_repair BEFORE UPDATE ON Execution WHEN NEW.id = 'audit-b' BEGIN SELECT RAISE(FAIL, 'deliberate second-row failure'); END`);
    const report = path.join(directory, 'partial-repair.jsonl');
    assert.throws(() => {
        execFileSync(process.execPath, ['--import', 'tsx', 'scripts/repair_trace_latency.ts', '--framework', 'jiuwenswarm', '--apply', '--report', report, 'audit-a', 'audit-b'], { stdio: 'pipe' });
    }, /P2003/);
    assert.equal((await client.execution.findUniqueOrThrow({ where: { id: 'audit-a' } })).latency, 61_187_865);
    assert.equal((await client.execution.findUniqueOrThrow({ where: { id: 'audit-b' } })).latency, 61_187.865);
    const journal = fs.readFileSync(report, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(journal.some(entry => entry.type === 'planned' && entry.id === 'audit-a' && entry.originalLatency === 61_187.865), 'original values must survive a later repair failure');
});
