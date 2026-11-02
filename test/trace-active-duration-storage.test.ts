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
import { repairTraceLatency } from '../src/lib/storage/repair-trace-latency';
import { executionBigIntToNumber } from '../src/lib/storage/prisma-client';

test('Effective latency survives ingestion, list statistics, detail reads and safe history repair', async context => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-active-storage-'));
    const savedEnvironment = { ...process.env };
    delete process.env.DB_HOST;
    delete process.env.AGENT_INSIGHT_DATA_DIR;
    process.env.AGENT_INSIGHT_HOME = directory;
    process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`;
    fs.writeFileSync(path.join(directory, 'test.db'), '');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
    const client = new PrismaClient();
    const globalWithPrisma = globalThis as typeof globalThis & { prisma?: unknown };
    const previousPrisma = globalWithPrisma.prisma;
    globalWithPrisma.prisma = client.$extends(executionBigIntToNumber);
    context.after(async () => {
        await client.$disconnect();
        globalWithPrisma.prisma = previousPrisma;
        for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
        Object.assign(process.env, savedEnvironment);
        fs.rmSync(directory, { recursive: true, force: true });
    });
    const { saveExecutionRecord, readRecordPage } = await import('../src/lib/storage/data-service');
    const { GET } = await import('../src/app/api/observe/session/route');
    const base = Date.parse('2026-10-30T01:00:00Z');
    const rows = [
        { role: 'user', content: 'first', timeInfo: { created: base } },
        { role: 'assistant', content: 'done', timeInfo: { created: base, completed: base + 20000 } },
        { role: 'user', content: 'second', timeInfo: { created: base + 3620000 } },
        { role: 'assistant', content: 'done', timeInfo: { created: base + 3620000, completed: base + 3650000 } },
    ];
    await saveExecutionRecord({ task_id: 'active-test', upload_id: 'active-test', framework: 'opencode', user: 'timing-test',
        query: 'active duration test', agentName: 'build', timestamp: new Date(base), interactions: rows, skip_evaluation: true,
        trace_started_at: new Date(base).toISOString(), trace_completed_at: new Date(base + 3650000).toISOString() });
    assert.equal((await client.execution.findUniqueOrThrow({ where: { id: 'active-test' } })).latency, 50000);
    const page = await readRecordPage('timing-test', undefined, { databasePagination: true, page: 1, pageSize: 10, lightweight: true, attachEvaluations: false });
    assert.equal(page.records[0].latency, 50000);
    assert.equal(page.stats.avgLatencyMs, 50000);
    const detail = await (await GET(new Request('http://localhost/api/observe/session?taskId=active-test&view=structure&source=raw'))).json();
    assert.equal(detail.execution.latency, 50000);
    const before = await client.execution.findUniqueOrThrow({ where: { id: 'active-test' } });
    const sessionBefore = await client.session.findUniqueOrThrow({ where: { taskId: 'active-test' } });
    await client.execution.update({ where: { id: 'active-test' }, data: { latency: 3650000 } });
    assert.equal((await repairTraceLatency(client)).changed, 1);
    assert.equal((await client.execution.findUniqueOrThrow({ where: { id: 'active-test' } })).latency, 3650000);
    const oldDetail = await (await GET(new Request('http://localhost/api/observe/session?taskId=active-test&view=structure&source=raw'))).json();
    assert.equal(oldDetail.execution.latency, 50000, 'historical detail uses recalculated metrics');
    assert.equal((await repairTraceLatency(client, { apply: true })).updated, 1);
    assert.deepEqual(await client.execution.findUniqueOrThrow({ where: { id: 'active-test' } }), before, 'only latency is repaired');
    assert.deepEqual(await client.session.findUniqueOrThrow({ where: { taskId: 'active-test' } }), sessionBefore);
    assert.equal((await repairTraceLatency(client, { apply: true })).changed, 0);
    for (const [id, framework, raw] of [['invalid', 'opencode', 'bad-json'], ['untimed', 'opencode', '[{"role":"user"}]'], ['other', 'qoder', JSON.stringify(rows)]]) {
        await client.execution.create({ data: { id, taskId: id, framework, latency: 123 } });
        await client.session.create({ data: { taskId: id, interactions: raw } });
    }
    const safe = await repairTraceLatency(client, { apply: true });
    assert.equal(safe.changed, 0);
    assert.equal(safe.skipped, 2);
    assert.equal((await client.execution.findUniqueOrThrow({ where: { id: 'other' } })).latency, 123);
});
