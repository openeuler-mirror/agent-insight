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
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import { executionBigIntToNumber } from '../src/lib/storage/prisma-client';
import { createIsolatedDatabase } from './helpers/isolated-database';

test('Trace page and statistics can be read independently while another transaction is open', async context => {
    const database = createIsolatedDatabase();
    process.env.DATABASE_URL += '?socket_timeout=1';
    const sql: string[] = [];
    const base = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    base.$on('query', event => sql.push(event.query));
    const client = base.$extends(executionBigIntToNumber);
    const globalState = globalThis as typeof globalThis & { prisma?: unknown };
    const previous = globalState.prisma;
    globalState.prisma = client;
    const writer = new PrismaClient();
    const { GET } = await import('../src/app/api/observe/data/route');
    context.after(async () => {
        await Promise.all([base.$disconnect(), writer.$disconnect()]);
        globalState.prisma = previous;
        database.dispose();
    });
    const now = Date.now();
    await client.execution.createMany({ data: Array.from({ length: 25 }, (_, index) => ({
        id: `split-${index}`, taskId: `split-${index}`, user: 'split-reader',
        timestamp: new Date(now - index * 1000), lastIngestedAt: new Date(now),
        framework: 'langfuse', agentName: index % 2 ? 'worker' : 'main', isSubagent: index >= 20,
        latency: index * 10, toolCallCount: 2, toolCallErrorCount: index % 2,
    })) });
    await client.execution.create({ data: { id: 'other-owner', user: 'someone-else', timestamp: new Date(now) } });
    await client.session.create({ data: { taskId: 'split-0', endTime: new Date(now) } });
    const url = 'http://localhost/api/observe/data?user=split-reader&paginated=1&databasePagination=1&fields=light&skipAutoEvalReady=1&pageSize=7';
    const request = async (query: string) => {
        const response = await GET(new Request(url + query));
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        return response.json();
    };

    await context.test('current page skips all statistics and reports whether a next page exists', async () => {
        sql.length = 0;
        const first = await request('&listPart=records');
        assert.equal(first.records.length, 7);
        assert.equal(first.hasMore, true);
        assert.equal(first.total, undefined);
        assert.equal(first.stats, undefined);
        assert.ok(!sql.some(query => /COUNT\(\*\) AS total|BEGIN/i.test(query)), sql.filter(query => /COUNT\(\*\) AS total|BEGIN/i.test(query)).join('\n'));
        const last = await request('&listPart=records&page=3');
        assert.equal(last.records.length, 6);
        assert.equal(last.hasMore, false);
        const beyond = await request('&listPart=records&page=4');
        assert.deepEqual(beyond.records, []);
        assert.equal(beyond.hasMore, false);
    });

    await context.test('statistics share every list filter without loading or hydrating page records', async () => {
        for (const filters of ['', '&onlySubagents=1', '&includeSubagents=1', '&agentName=main', '&framework=missing', '&status=running', '&status=success', '&anomaly=unknown', '&sort=cost', '&sort=status', '&query=split-1', '&time=30m']) {
            const combined = await request(filters);
            sql.length = 0;
            const stats = await request(filters + '&listPart=stats');
            assert.deepEqual(stats.stats, combined.stats, filters);
            assert.equal(stats.records, undefined, 'stats response must not include a page');
            assert.ok(!sql.some(query => /BEGIN/i.test(query)), 'stats must not reserve a writer');
            assert.ok(!sql.some(query => /TrajectoryEvalResult|ExperimentEvalCase/i.test(query)), 'stats must skip page enrichment');
            const page = await request(filters + '&listPart=records');
            assert.deepEqual(page.records.map((record: any) => record.upload_id), combined.records.map((record: any) => record.upload_id), filters);
            assert.equal(page.hasMore, combined.total > 7, filters);
        }
    });

    await context.test('excluded collaboration children stay excluded from both records and statistics', async () => {
        const { readRecordPage } = await import('../src/lib/storage/data-service');
        const filters = { excludedTaskIds: ['split-0', 'split-1'] };
        const options = { lightweight: true, databasePagination: true, page: 1, pageSize: 30 };
        const page = await readRecordPage('split-reader', filters, options, 'records');
        const stats = await readRecordPage('split-reader', filters, options, 'stats');
        assert.equal(stats.total, 18);
        assert.equal(page.records.length, 18);
        assert.ok(page.records.every(record => !filters.excludedTaskIds.includes(record.task_id ?? '')));
    });

    await context.test('ordinary and computed pages plus statistics remain readable under a reserved write lock', async () => {
        for (const mode of ['DELETE', 'WAL']) {
            await client.$queryRawUnsafe(`PRAGMA journal_mode=${mode}`);
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const ready = new Promise<void>(resolve => { entered = resolve; });
            const holding = writer.$transaction(async tx => {
                await tx.$queryRaw`SELECT id FROM "Execution" LIMIT 1`;
                entered();
                await gate;
            }, { timeout: 15_000 });
            try {
                await Promise.race([ready, holding]);
                for (const filters of ['', '&status=running']) {
                    assert.equal((await request(filters + '&listPart=records')).records.length, 7, mode);
                    assert.ok((await request(filters + '&listPart=stats')).stats.total > 0, mode);
                }
            } finally {
                release();
                await holding;
            }
        }
    });
});
