import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTraceForest, CollaborationProjection, type TraceLink } from '../src/lib/collaboration/projection';
import { buildCollaborationTraceTree, sameCollaborationSource } from '../src/lib/collaboration/display-tree';
import { buildAgentCallTree } from '../src/lib/engine/observability/agent-trace';
import type { CollaborationService } from '../src/lib/collaboration/service';

const link = (parent: string, child: string): TraceLink => ({ parent, child, anchor: { status: 'not_provided', message: '无定位信息' } });
const call = (id: string, name: string, agent: string) => ({ role: 'assistant', agent, content: `${agent} 原文`, tool_calls: [{ id, function: { name, arguments: '{}' }, output: `${name} 输出` }] });
const annotate = (taskId: string, item: any, index: number, relation?: TraceLink) => ({ ...item, _collaboration: { taskId, index, version: 'v1', parent: relation?.parent, anchor: relation?.anchor, sequential: relation?.sequential, order: relation?.order } });

test('forest rejects cyclic and multiple-parent components, deduplicates repeated reports', () => {
    assert.deepEqual(resolveTraceForest([link('A', 'B'), link('A', 'B'), link('B', 'C')]).map(x => [x.parent, x.child]), [['A', 'B'], ['B', 'C']]);
    for (const bad of [[link('A', 'A'), link('A', 'B')], [link('A', 'B'), link('B', 'A')], [link('A', 'B'), link('C', 'B')]]) {
        assert.deepEqual(resolveTraceForest([...bad, link('B', 'D'), link('E', 'F')]), [link('E', 'F')]);
    }
});

test('independent traces merge at the custom tool candidate and preserve global source indices', () => {
    const parent = [call('dispatch', 'bash', 'Parent')];
    const child = [call('read', 'read_file', 'Child'), call('check', 'bash', 'Child')];
    assert.equal(buildAgentCallTree(parent)?.children.length, 0);
    const relation: TraceLink = { parent: 'A', child: 'B', anchor: { status: 'candidate', message: '唯一候选', candidates: [{ name: 'bash', recordId: 'dispatch', interactionIndex: 0, callIndex: 0 }] } };
    const combined = [...parent.map((x, i) => annotate('A', x, i)), ...child.map((x, i) => annotate('B', x, i, relation))];
    const tree = buildCollaborationTraceTree(combined)!;
    assert.equal(tree.children.length, 1);
    const subagent = tree.children[0];
    assert.equal(tree.events.find(x => x.toolCallId === 'dispatch')?.spawnedChildId, subagent.id);
    assert.equal((subagent as any).collaborationLabel, '上报关联 · 候选步骤');
    assert.deepEqual(subagent.events.filter(x => x.toolCallId).map(x => x.toolCallId), ['read', 'check']);
    assert.deepEqual(subagent.interactionIndices, [1, 2]);
    assert.equal(subagent.events.find(x => x.toolCallId === 'check')?.interactionIndex, 2);
    assert.equal(combined[2]._collaboration.index, 1);
    assert.equal(combined[2].content, 'Child 原文');
    assert.equal((parent[0] as any)._collaboration, undefined);
});

test('no locator and ambiguous positions retain child at Agent level; native tree stays unchanged', () => {
    for (const status of ['not_provided', 'ambiguous', 'not_found'] as const) {
        const relation = { ...link('A', 'B'), anchor: { status, message: '不可确定步骤' } };
        const tree = buildCollaborationTraceTree([annotate('A', call('a', 'bash', 'Parent'), 0), annotate('B', call('b', 'read', 'Child'), 0, relation)])!;
        assert.equal(tree.children.length, 1);
        assert.ok(tree.events.every(x => !x.spawnedChildId));
        assert.match((tree.children[0] as any).collaborationLabel, /未定位/);
    }
    const native = [call('a', 'bash', 'Parent')];
    assert.deepEqual(buildCollaborationTraceTree(native), buildAgentCallTree(native));
});

test('multiple levels have unique node IDs and source changes invalidate deferred body reuse', () => {
    const items = [annotate('A', call('a', 'bash', 'A'), 0), annotate('B', call('b', 'read', 'B'), 0, link('A', 'B')), annotate('C', call('c', 'bash', 'C'), 0, link('B', 'C'))];
    const root = buildCollaborationTraceTree(items)!;
    assert.equal(root.children[0].children[0].depth, 2);
    assert.equal(new Set([root.id, root.children[0].id, root.children[0].children[0].id]).size, 3);
    assert.equal(sameCollaborationSource(items[0], { ...items[0], content: 'loaded' }), true);
    assert.equal(sameCollaborationSource(items[0], items[1]), false);
    assert.equal(sameCollaborationSource(items[0], { _collaboration: { ...items[0]._collaboration, version: 'v2' } }), false);
});

test('projection never reads another owner body and preserves original source metadata', async () => {
    const projection = new CollaborationProjection({} as CollaborationService);
    projection.links = async () => [link('A', 'B')];
    const load = async (id: string) => ({ session: { user: 'alice' }, interactions: [call(id, 'bash', id)] });
    const result = await projection.interactions('alice', 'A', load);
    assert.equal(result?.length, 2);
    assert.equal(result?.[1]._collaboration.taskId, 'B');
    assert.equal(result?.[1]._collaboration.index, 0);
    assert.equal(await projection.interactions('bob', 'A', load), null);
    assert.equal(await projection.interactions('alice', 'A', async id => id === 'B' ? null : load(id)), null);
});

test('independent Goal Plus workers merge as soon as each body is available', async () => {
    const projection = new CollaborationProjection({} as CollaborationService);
    projection.links = async () => [
        { ...link('A', 'B'), independent: true },
        { ...link('A', 'C'), independent: true },
    ];
    const load = async (id: string) => id === 'B'
        ? null
        : { session: { user: 'alice' }, interactions: [call(id, 'bash', id)] };
    const result = await projection.interactions('alice', 'A', load);
    assert.deepEqual(result?.map(item => item._collaboration.taskId), ['A', 'C']);
});

test('no locator places all Agents side by side in one Trace, while located child remains nested', () => {
    const sequential = { ...link('A', 'B'), sequential: true };
    const c = { ...link('B', 'C'), sequential: true };
    const items = [annotate('A', call('a', 'bash', 'A'), 0), annotate('B', call('b', 'read', 'B'), 0, sequential), annotate('C', call('c', 'bash', 'C'), 0, c)];
    const root = buildCollaborationTraceTree(items)!;
    assert.equal(root.agentName, '协作 Trace');
    assert.deepEqual(root.children.map(x => x.agentName), ['A', 'B', 'C']);
    assert.ok(root.children.every(x => x.depth === 1 && x.children.length === 0));
    assert.equal(root.events.length, 0);
});

test('HTTP handlers and SQLite merge locator-free reports, recompute late traces, and isolate owners', async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { PrismaClient } = await import('@prisma/client');
    const { spawnSync } = await import('node:child_process');
    const { CollaborationService } = await import('../src/lib/collaboration/service');
    const { CollaborationStore, sqlDatabase } = await import('../src/lib/collaboration/store');
    const { createCollaborationHandlers } = await import('../src/lib/collaboration/http');
    const url = `file:${join(await mkdtemp(join(tmpdir(), 'collaboration-projection-')), 'test.db')}`;
    const setup = spawnSync('node_modules/.bin/prisma', ['db', 'push', '--skip-generate'], { env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const client = new PrismaClient({ datasources: { db: { url } } });
    const service = new CollaborationService(new CollaborationStore(sqlDatabase(client)));
    const projection = new CollaborationProjection(service);
    const handlers = createCollaborationHandlers({ service, authenticate: async key => key === 'test-only-key' ? 'alice' : null });
    const request = (body: unknown) => new Request('http://localhost/api', { method: 'POST', headers: { 'content-type': 'application/json', 'x-witty-api-key': 'test-only-key' }, body: JSON.stringify(body) });
    try {
        for (const id of ['A', 'B', 'C']) {
            await client.execution.create({ data: { id, taskId: id, user: 'alice', framework: 'opencode' } });
            if (id !== 'C') await client.session.create({ data: { taskId: id, user: 'alice', interactions: JSON.stringify([call(id, 'bash', id)]) } });
            assert.equal((await handlers.bind(request({ collaborationId: 'sequence', sessionId: id, traceSessionId: id }))).status, 201);
        }
        const event = { collaborationId: 'sequence', eventId: 'one', fromSessionId: 'A', toSessionId: 'B', description: '顺序执行 B', observedAt: '2026-09-14T01:00:00Z' };
        assert.equal((await handlers.report(request(event))).status, 201);
        assert.equal((await handlers.report(request(event))).status, 200);
        assert.equal((await projection.links('alice')).length, 1);
        assert.equal((await handlers.report(request({ ...event, eventId: 'two', fromSessionId: 'B', toSessionId: 'C', observedAt: '2026-09-14T01:00:01Z' }))).status, 201);
        assert.equal((await projection.links('alice')).length, 0);
        await client.session.create({ data: { taskId: 'C', user: 'alice', interactions: JSON.stringify([call('C', 'read_file', 'C')]) } });

        const goalPlusCollaborationId = `gp.${'a'.repeat(32)}`;
        const workerSessionId = 'worker:run-a:search-a';
        const workerTraceId = 'goal-plus-worker-trace';
        await client.execution.create({ data: { id: workerTraceId, taskId: workerTraceId, user: 'alice', framework: 'pi-agent' } });
        await client.session.create({ data: { taskId: workerTraceId, user: 'alice', interactions: JSON.stringify([call('worker', 'bash', 'worker')]) } });
        assert.equal((await handlers.bind(request({ collaborationId: goalPlusCollaborationId, sessionId: workerSessionId, traceSessionId: workerTraceId }))).status, 201);
        assert.equal((await handlers.report(request({
            collaborationId: goalPlusCollaborationId,
            eventId: 'goal-plus-worker-started',
            fromSessionId: 'main',
            toSessionId: workerSessionId,
            description: 'Goal Plus 启动 worker',
        }))).status, 201);
        const claimedPlan = await projection.plan('alice');
        assert.ok(claimedPlan.hiddenChildren.includes(workerTraceId));
        assert.equal(claimedPlan.links.some(item => item.child === workerTraceId), false);

        const mainTraceId = 'goal-plus-main-trace';
        await client.execution.create({ data: { id: mainTraceId, taskId: mainTraceId, user: 'alice', framework: 'pi-agent' } });
        await client.session.create({ data: { taskId: mainTraceId, user: 'alice', interactions: JSON.stringify([call('main', 'goal_plus', 'main')]) } });
        assert.equal((await handlers.bind(request({ collaborationId: goalPlusCollaborationId, sessionId: 'main', traceSessionId: mainTraceId }))).status, 201);
        const mergeablePlan = await projection.plan('alice');
        assert.ok(mergeablePlan.hiddenChildren.includes(workerTraceId));
        assert.ok(mergeablePlan.links.some(item => item.parent === mainTraceId && item.child === workerTraceId));

        const pendingWorkerSessionId = 'worker:run-a:search-b';
        const pendingWorkerTraceId = 'goal-plus-pending-worker-trace';
        await client.execution.create({ data: { id: pendingWorkerTraceId, taskId: pendingWorkerTraceId, user: 'alice', framework: 'pi-agent' } });
        assert.equal((await handlers.bind(request({ collaborationId: goalPlusCollaborationId, sessionId: pendingWorkerSessionId, traceSessionId: pendingWorkerTraceId }))).status, 201);
        assert.equal((await handlers.report(request({
            collaborationId: goalPlusCollaborationId,
            eventId: 'goal-plus-pending-worker-started',
            fromSessionId: 'main',
            toSessionId: pendingWorkerSessionId,
            description: 'Goal Plus 启动另一个 worker',
        }))).status, 201);
        const partialPlan = await projection.plan('alice');
        assert.ok(partialPlan.hiddenChildren.includes(pendingWorkerTraceId));
        assert.ok(partialPlan.pendingChildren.includes(pendingWorkerTraceId));
        assert.ok(partialPlan.links.some(item => item.child === workerTraceId), 'pending worker must not block the ready worker');
        assert.equal(partialPlan.links.some(item => item.child === pendingWorkerTraceId), false);

        await client.session.create({ data: { taskId: pendingWorkerTraceId, user: 'alice', interactions: JSON.stringify([call('pending-worker', 'read_file', 'pending-worker')]) } });
        const completedPlan = await projection.plan('alice');
        assert.ok(completedPlan.links.some(item => item.child === workerTraceId));
        assert.ok(completedPlan.links.some(item => item.child === pendingWorkerTraceId));
        assert.equal(completedPlan.pendingChildren.includes(pendingWorkerTraceId), false);

        await client.$executeRawUnsafe(
            'INSERT INTO "Collaboration" ("id","user","collaborationId","sourceType","createdAt") VALUES (?,?,?,?,?)',
            'goal-group', 'alice', 'collab_gp_fixture', 'goal-plus-semantic', new Date().toISOString());
        await client.$executeRawUnsafe(
            'INSERT INTO "CollaborationEvent" ("id","collaborationDbId","user","collaborationId","eventId","fromSessionId","toSessionId","description","sourceType","bodyJson","bodyHash","receivedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
            'goal-event', 'goal-group', 'alice', 'collab_gp_fixture', 'goal-event', 'A', 'B', 'goal relation',
            'goal-plus-semantic', 'not a reported event JSON', 'fixture-hash', new Date().toISOString());
        const links = await projection.links('alice');
        assert.deepEqual(links.filter(x => ['A', 'B', 'C'].includes(x.parent)).map(x => [x.parent, x.child, x.sequential]), [['A', 'B', true], ['B', 'C', true]]);
        const merged = await projection.interactions('alice', 'A', async taskId => {
            const session = await client.session.findUnique({ where: { taskId } });
            return session ? { session, interactions: JSON.parse(session.interactions!) } : null;
        });
        assert.deepEqual(buildCollaborationTraceTree(merged!)?.children.map(x => x.agentName), ['A', 'B', 'C']);
        assert.deepEqual(await projection.links('bob'), []);
        assert.equal(await client.execution.count({ where: { isSubagent: true } }), 0);
        const page = await client.execution.findMany({ where: { user: 'alice', taskId: { notIn: links.map(x => x.child) } }, take: 1 });
        assert.equal(page[0].taskId, 'A');
    } finally { await client.$disconnect(); }
});
