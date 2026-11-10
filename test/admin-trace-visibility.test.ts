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
import { createIsolatedDatabase } from './helpers/isolated-database';

test('administrator Trace reads and dashboard aggregates share the global scope', async context => {
    const database = createIsolatedDatabase();
    const savedAdmins = process.env.AGENT_INSIGHT_ADMIN_USERS;
    delete process.env.AGENT_INSIGHT_ADMIN_USERS;
    const { prismaRaw } = await import('@/lib/storage/prisma');
    const [data, session, trends, breakdowns, agent, reliability, dashboard, traceExport] = await Promise.all([
        import('@/app/api/observe/data/route'),
        import('@/app/api/observe/session/route'),
        import('@/app/api/fleet/trends/route'),
        import('@/app/api/fleet/breakdowns/route'),
        import('@/app/api/fleet/agent/route'),
        import('@/app/api/fleet/reliability/route'),
        import('@/app/api/dashboard/stats/route'),
        import('@/app/api/observe/traces/export/route'),
    ]);
    context.after(async () => {
        await prismaRaw.$disconnect();
        if (savedAdmins === undefined) delete process.env.AGENT_INSIGHT_ADMIN_USERS;
        else process.env.AGENT_INSIGHT_ADMIN_USERS = savedAdmins;
        database.dispose();
    });
    for (const username of ['admin', 'alice', 'bob', 'operator']) {
        await prismaRaw.user.create({ data: { username, apiKey: `test-key-${username}` } });
    }
    const timestamp = new Date();
    for (const owner of ['admin', 'alice', 'bob', null]) {
        const id = `trace-${owner ?? 'unowned'}`;
        await prismaRaw.execution.create({ data: {
            id, taskId: id, user: owner, timestamp, lastIngestedAt: timestamp,
            framework: owner ?? 'unowned', agentName: 'worker', latency: 1,
            tokens: 100, inputTokens: 80, outputTokens: 20, model: 'test-model',
        } });
        await prismaRaw.session.create({ data: {
            taskId: id, user: owner, startTime: timestamp, endTime: timestamp,
            interactions: JSON.stringify([{ role: 'user', content: id }]),
        } });
    }
    const request = (url: string, username?: string) => new Request(`http://localhost${url}`, {
        headers: username ? { 'x-witty-api-key': `test-key-${username}` } : {},
    });
    const json = async (route: { GET(request: Request): Promise<Response> }, url: string, username: string) => {
        const response = await route.GET(request(url, username));
        assert.equal(response.status, 200, await response.clone().text());
        return response.json();
    };
    const listUrl = '/api/observe/data?user=admin&paginated=1&databasePagination=1&fields=light&skipAutoEvalReady=1';

    await context.test('admin sees every owner including unowned records and matching statistics', async () => {
        const page = await json(data, listUrl + '&listPart=records', 'admin');
        assert.equal(page.records.length, 4);
        assert.equal(page.canViewAllTraces, true);
        assert.deepEqual(new Set(page.records.map((row: { user: string | null }) => row.user)), new Set(['admin', 'alice', 'bob', null]));
        const stats = await json(data, listUrl + '&listPart=stats', 'admin');
        assert.equal(stats.stats.total, 4);
        const filtered = await json(data, listUrl + '&framework=bob', 'admin');
        assert.deepEqual(filtered.records.map((row: { user: string }) => row.user), ['bob']);
    });

    await context.test('authenticated ordinary users cannot override their scope with a query user', async () => {
        const page = await json(data, listUrl, 'alice');
        assert.deepEqual(page.records.map((row: { user: string }) => row.user), ['alice']);
        assert.equal(page.canViewAllTraces, false);
        assert.equal(page.stats.total, 1);
        const denied = await data.GET(request('/api/observe/data?user=alice&executionId=trace-bob', 'alice'));
        assert.equal(denied.status, 403);
    });

    await context.test('admin user filters constrain records and statistics without granting ordinary cross-user reads', async () => {
        const url = listUrl + '&traceUser=bob';
        for (const part of ['', '&listPart=records']) {
            const page = await json(data, url + part, 'admin');
            assert.deepEqual(page.records.map((row: { user: string }) => row.user), ['bob']);
            assert.equal(page.canViewAllTraces, true);
        }
        assert.equal((await json(data, url + '&listPart=stats', 'admin')).stats.total, 1);
        assert.equal((await json(data, url + '&framework=alice', 'admin')).records.length, 0);
        const own = await json(data, url, 'alice');
        assert.deepEqual(own.records.map((row: { user: string }) => row.user), ['alice']);
        assert.equal(own.stats.total, 1);
        const missing = await json(data, listUrl + '&traceUser=missing-user', 'admin');
        assert.deepEqual(missing.records, []);
        assert.equal(missing.stats.total, 0);
        assert.equal((await json(data, listUrl + '&traceUser=', 'admin')).records.length, 4);
    });

    await context.test('user filter options contain all Trace owners for admin and only self for ordinary users', async () => {
        const url = '/api/observe/data?user=admin&traceUser=bob&facet=values&column=user';
        const all = await json(data, url, 'admin');
        assert.deepEqual(new Set(all.map((row: { value: string }) => row.value)), new Set(['admin', 'alice', 'bob']));
        const own = await json(data, url, 'alice');
        assert.deepEqual(own, [{ value: 'alice', count: 1 }]);
    });

    await context.test('admin can open another owner session while ordinary users cannot', async () => {
        const url = '/api/observe/session?taskId=trace-bob';
        assert.equal((await session.GET(request(url, 'admin'))).status, 200);
        assert.equal((await session.GET(request(url, 'alice'))).status, 403);
    });

    await context.test('legacy sessions without an owner remain readable by their execution owner', async () => {
        await prismaRaw.session.update({ where: { taskId: 'trace-alice' }, data: { user: null } });
        const url = '/api/observe/session?taskId=trace-alice';
        assert.equal((await session.GET(request(url, 'alice'))).status, 200);
        assert.equal((await session.GET(request(url, 'bob'))).status, 403);
    });

    await context.test('admin facets contain every owner while ordinary facets stay isolated', async () => {
        const url = '/api/observe/data?user=admin&facet=values&column=framework';
        const all = await json(data, url, 'admin');
        assert.equal(all.length, 4);
        const own = await json(data, url, 'alice');
        assert.deepEqual(own.map((row: { value: string }) => row.value), ['alice']);
    });

    await context.test('global reads preserve owner tags and filter records and statistics by them', async () => {
        const { createTraceTag, replaceExecutionTraceTags } = await import('@/lib/trace-tags');
        const tag = await createTraceTag('bob', { kind: 'business', name: 'Bob business' });
        await replaceExecutionTraceTags('trace-bob', 'bob', [tag.id]);
        const page = await json(data, listUrl + '&includeTags=1', 'admin');
        assert.deepEqual(page.records.find((row: { user: string }) => row.user === 'bob').userTags.map((item: { id: string }) => item.id), [tag.id]);
        for (const parameter of ['tagIds', 'bizTag']) {
            const url = listUrl + `&${parameter}=${tag.id}`;
            const filtered = await json(data, url, 'admin');
            assert.deepEqual(filtered.records.map((row: { user: string }) => row.user), ['bob'], parameter);
            assert.equal(filtered.stats.total, 1, parameter);
            assert.equal((await json(data, url, 'alice')).records.length, 0, parameter);
        }
    });

    await context.test('all dashboard endpoints use global admin data and owner data for ordinary users', async () => {
        for (const [route, url, count] of [
            [trends, '/api/fleet/trends?window=24h&user=admin', (body: { kpi: { current: { traces: number } } }) => body.kpi.current.traces],
            [breakdowns, '/api/fleet/breakdowns?window=24h&user=admin', (body: { callStatsCoverage: { total: number } }) => body.callStatsCoverage.total],
            [agent, '/api/fleet/agent?window=24h&user=admin&name=worker', (body: { stats: { traces: number } }) => body.stats.traces],
            [reliability, '/api/fleet/reliability?window=24h&user=admin', (body: { kpi: { totalTraces: number } }) => body.kpi.totalTraces],
            [dashboard, '/api/dashboard/stats?agentOwnership=all', (body: { health: { todayCalls: number } }) => body.health.todayCalls],
        ] as const) {
            assert.equal(count(await json(route, url, 'admin')), 4, url);
            assert.equal(count(await json(route, url, 'alice')), 1, url);
        }
    });

    await context.test('query usernames and invalid credentials do not grant global admin access', async () => {
        const response = await data.GET(request(listUrl));
        const page = await response.json();
        assert.equal(page.canViewAllTraces, false);
        assert.deepEqual(page.records.map((row: { user: string }) => row.user), ['admin']);
        assert.equal((await data.GET(request(listUrl, 'invalid'))).status, 401);
        assert.equal((await data.GET(request('/api/observe/data'))).status, 401);
    });

    await context.test('configured administrators use the same global scope', async () => {
        process.env.AGENT_INSIGHT_ADMIN_USERS = 'operator';
        try {
            assert.equal((await json(data, listUrl, 'operator')).records.length, 4);
            assert.equal((await json(data, listUrl, 'admin')).records.length, 1);
        } finally {
            delete process.env.AGENT_INSIGHT_ADMIN_USERS;
        }
    });

    await context.test('global read access includes trace export without changing ownership', async () => {
        const url = '/api/observe/traces/export?executionId=trace-bob&user=admin';
        assert.equal((await traceExport.GET(request(url, 'admin'))).status, 200);
        assert.equal((await traceExport.GET(request(url, 'alice'))).status, 404);
        assert.equal((await prismaRaw.execution.findUnique({ where: { id: 'trace-bob' } }))?.user, 'bob');
        const unowned = '/api/observe/traces/export?executionId=trace-unowned';
        assert.equal((await traceExport.GET(request(unowned, 'admin'))).status, 200);
        assert.equal((await traceExport.GET(request(unowned, 'alice'))).status, 404);
        assert.equal((await traceExport.GET(request('/api/observe/traces/export?executionId=trace-alice', 'alice'))).status, 200);
    });

    await context.test('global nonpaginated reads preserve distinct owners sharing a task ID', async () => {
        await prismaRaw.execution.createMany({ data: [
            { id: 'alice-shared', taskId: 'same-task', user: 'alice', timestamp, agentName: 'shared-worker' },
            { id: 'bob-shared', taskId: 'same-task', user: 'bob', timestamp, agentName: 'shared-worker' },
        ] });
        const page = await json(data, '/api/observe/data?taskId=same-task&fields=light&skipAutoEvalReady=1', 'admin');
        assert.deepEqual(new Set(page.map((row: { user: string }) => row.user)), new Set(['alice', 'bob']));
        assert.equal(await prismaRaw.execution.count({ where: { taskId: 'same-task' } }), 2);
        const detail = await json(agent, '/api/fleet/agent?name=shared-worker&window=24h', 'admin');
        assert.equal(detail.stats.traces, 2);
    });
});
