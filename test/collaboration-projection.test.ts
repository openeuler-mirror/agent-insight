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
        assert.equal((await handlers.report(request({ ...event, eventId: 'return', fromSessionId: 'C', toSessionId: 'A' }))).status, 201);
        const links = await projection.links('alice');
        assert.deepEqual(links.filter(x => ['A', 'B', 'C'].includes(x.parent)).map(x => [x.parent, x.child, x.sequential]), [['A', 'B', true], ['A', 'C', true]]);
        const merged = await projection.interactions('alice', 'A', async taskId => {
            const session = await client.session.findUnique({ where: { taskId } });
            return session ? { session, interactions: JSON.parse(session.interactions!) } : null;
        });
        assert.deepEqual(buildCollaborationTraceTree(merged!)?.children.map(x => x.agentName), ['A', 'B', 'C']);
        assert.deepEqual(await projection.links('bob'), []);
        assert.equal(await client.execution.count({ where: { isSubagent: true } }), 0);
        const page = await client.execution.findMany({ where: { user: 'alice', taskId: { notIn: links.map(x => x.child) } }, take: 1 });
        assert.equal(page[0].taskId, 'A');

        const history = Array.from({ length: 201 }, (_, index) => `history-${String(index).padStart(3, '0')}`);
        const now = new Date().toISOString();
        const traceIds = history.flatMap(id => [`${id}-parent`, `${id}-child`]);
        await client.execution.createMany({ data: traceIds.map(id => ({ id, taskId: id, user: 'alice', framework: 'mcts-xgovernor' })) });
        await client.session.createMany({ data: traceIds.map(taskId => ({ taskId, user: 'alice', interactions: JSON.stringify([call(taskId, 'read', taskId)]) })) });
        await client.collaboration.createMany({ data: history.map(id => ({ id, user: 'alice', collaborationId: id, createdAt: now })) });
        await client.collaborationEvent.createMany({ data: history.map(id => ({
            id, collaborationDbId: id, user: 'alice', collaborationId: id, eventId: id,
            fromSessionId: `${id}-parent`, toSessionId: `${id}-child`,
            eventBodyJson: JSON.stringify({ collaborationId: id, eventId: id, fromSessionId: `${id}-parent`, toSessionId: `${id}-child`, description: 'dispatch' }),
            contentHash: 'fixture', receivedAt: now,
        })) });
        const largePlan = await projection.plan('alice');
        assert.ok(history.every(id => largePlan.hiddenChildren.includes(`${id}-child`)));
        assert.ok(largePlan.links.some(link => link.child === workerTraceId));
        assert.ok(largePlan.links.some(link => link.parent === 'A' && link.child === 'B'));
        const listWhere = { user: 'alice', taskId: { notIn: largePlan.hiddenChildren, startsWith: 'history-' } };
        assert.equal(await client.execution.count({ where: listWhere }), 201);
        const secondPage = await client.execution.findMany({ where: listWhere, orderBy: { taskId: 'asc' }, skip: 10, take: 10 });
        assert.deepEqual(secondPage.map(row => row.taskId), history.slice(10, 20).map(id => `${id}-parent`));

        const originalGraph = service.graph.bind(service);
        service.graph = async (user, id, ...args) => {
            if (id === history[0]) throw new Error('one collaboration unavailable');
            return originalGraph(user, id, ...args);
        };
        const partialFailure = await projection.plan('alice');
        assert.equal(partialFailure.hiddenChildren.includes(`${history[0]}-child`), false);
        assert.ok(partialFailure.hiddenChildren.includes(`${history[200]}-child`));
        assert.ok(partialFailure.hiddenChildren.includes(workerTraceId));
        assert.deepEqual((await projection.plan('bob')).hiddenChildren, []);
    } finally { await client.$disconnect(); }
});

type ProjectionGroupFixture = {
    id: string;
    tasks: string[];
    parents?: number[];
    bytes?: number;
    pending?: Set<string>;
    failure?: 'snapshot' | 'graph' | 'body' | 'incomplete';
    eventCount?: number;
};

function projectionFixture(groups: ProjectionGroupFixture[]) {
    const pages: string[] = [];
    const byId = new Map(groups.map(group => [group.id, group]));
    const sessionId = (group: ProjectionGroupFixture, index: number) => group.id.startsWith('gp.')
        ? index === 0 ? 'main' : `worker:${index}` : `runtime:${index}`;
    const events = (group: ProjectionGroupFixture) => group.tasks.slice(1).map((_, index) => ({
        eventId: `${group.id}:${index}`, fromSessionId: sessionId(group, group.parents?.[index] ?? 0),
        toSessionId: sessionId(group, index + 1), fromLocator: { toolName: 'task' },
        fromAnchor: { status: 'confirmed', position: { interactionIndex: index, callIndex: 0, callKey: `${index}` } },
    }));
    const service = {
        store: {
            sql: {
                rows: async (sql: string, values: string[]) => {
                    assert.equal(values[0], 'alice');
                    if (sql.includes('WITH endpoints')) return byId.get(values[1])!.tasks.map(traceSessionId => ({ traceSessionId }));
                    if (sql.includes('FROM "Collaboration"')) {
                        pages.push(values[1]);
                        return groups.filter(group => group.id > values[1]).sort((a, b) => a.id.localeCompare(b.id))
                            .slice(0, 200).map(group => ({ collaborationId: group.id }));
                    }
                    const group = groups.find(group => group.tasks.includes(values[1]))!;
                    if (group.failure === 'body') throw new Error('body metadata unavailable');
                    if (group.pending?.has(values[1])) return [];
                    return [{ bytes: group.bytes ?? 200_000, embedded: null, isSubagent: false, id: values[1], agentName: values[1], framework: 'test' }];
                },
            },
            snapshot: async (_user: string, id: string) => {
                const group = byId.get(id)!;
                if (group.failure === 'snapshot') throw new Error('snapshot unavailable');
                return {
                    complete: true,
                    bindings: group.tasks.map((traceSessionId, index) => ({ sessionId: sessionId(group, index), traceSessionId })),
                    events: events(group).map(event => ({ sourceType: 'reported', bodyJson: JSON.stringify(event) })),
                };
            },
        },
        graph: async (_user: string, id: string) => {
            const group = byId.get(id)!;
            if (group.failure === 'graph') throw new Error('graph unavailable');
            const reported = events(group);
            return {
                resolutionComplete: group.failure !== 'incomplete',
                nodes: group.tasks.map((task, index) => ({ sessionId: sessionId(group, index), traceSessionId: task, executionId: task })),
                events: group.eventCount ? Array.from({ length: group.eventCount }, () => reported[0]) : reported,
            };
        },
    };
    return { projection: new CollaborationProjection(service as unknown as CollaborationService), pages };
}

function projectionGroup(index: number, goalPlus = false, count = 11): ProjectionGroupFixture {
    return {
        id: goalPlus ? `gp.${index.toString(16).padStart(32, '0')}` : `mcts.${String(index).padStart(4, '0')}`,
        tasks: Array.from({ length: count }, (_, member) => `trace-${index}-${member}`),
    };
}

test('MCTS and Goal Plus keep merging beyond account-wide group, session, relation and byte limits', async () => {
    const groups = Array.from({ length: 205 }, (_, index) => projectionGroup(index, index % 2 === 0));
    const mcts = projectionGroup(1000, false, 7);
    mcts.parents = [0, 0, 2, 0, 0, 0];
    groups.push(mcts);
    const { projection, pages } = projectionFixture(groups);
    const plan = await projection.plan('alice');
    assert.equal(plan.unavailable, undefined);
    assert.equal(plan.links.length, 2056);
    assert.equal(plan.hiddenChildren.length, 2056);
    assert.equal(pages.length, 2);
    assert.ok(plan.links.some(link => link.parent === mcts.tasks[2] && link.child === mcts.tasks[3]));
    assert.ok(plan.links.some(link => link.independent && link.parent === groups[0].tasks[0]));
    const merged = await projection.interactions('alice', mcts.tasks[0], async taskId => ({
        session: { user: 'alice' }, interactions: [call(taskId, 'read', taskId)],
    }), plan);
    assert.equal(merged?.length, 7);
    assert.deepEqual(new Set(merged?.map(item => item._collaboration.taskId)), new Set(mcts.tasks));
    assert.equal(await projection.interactions('alice', mcts.tasks[0], async () => ({
        session: { user: 'bob' }, interactions: [call('private', 'read', 'private')],
    }), plan), null);
});

test('Goal Plus late workers retain pending and parent navigation behavior among many historical traces', async () => {
    const live = projectionGroup(1000, true, 3);
    live.pending = new Set([live.tasks[2]]);
    const { projection } = projectionFixture([...Array.from({ length: 101 }, (_, i) => projectionGroup(i, false, 2)), live]);
    const pending = await projection.plan('alice');
    assert.ok(pending.hiddenChildren.includes(live.tasks[2]));
    assert.ok(pending.pendingChildren.includes(live.tasks[2]));
    assert.equal(pending.links.some(link => link.child === live.tasks[2]), false);
    assert.equal(pending.parentAgents?.[live.tasks[1]].state, 'resolved');
    assert.ok(pending.links.some(link => link.child === live.tasks[1]));
    live.pending.clear();
    const ready = await projection.plan('alice');
    assert.ok(ready.links.some(link => link.child === live.tasks[2]));
    assert.equal(ready.pendingChildren.includes(live.tasks[2]), false);
    assert.equal(ready.parentAgents?.[live.tasks[2]].state, 'resolved');
});

test('failed or oversized groups degrade only their connected traces, including cross-group aliases', async () => {
    for (const kind of ['snapshot', 'graph', 'body', 'incomplete', 'sessions', 'bytes', 'events'] as const) {
        const broken = projectionGroup(1, false, kind === 'sessions' ? 201 : 2);
        if (kind === 'sessions') broken.bytes = 10;
        else if (kind === 'bytes') broken.bytes = 17 * 1024 * 1024;
        else if (kind === 'events') broken.eventCount = 2001;
        else broken.failure = kind;
        const connected = projectionGroup(2, true, 2);
        connected.tasks[0] = broken.tasks.at(-1)!;
        const unaffected = projectionGroup(3, true, 2);
        const healthy = projectionGroup(4, false, 2);
        const { projection } = projectionFixture([broken, connected, unaffected, healthy]);
        const plan = await projection.plan('alice');
        assert.equal(plan.unavailable, undefined, kind);
        assert.deepEqual(new Set(plan.hiddenChildren), new Set([unaffected.tasks[1], healthy.tasks[1]]), kind);
        assert.equal(plan.parentAgents?.[connected.tasks[1]].state, 'unavailable', kind);
        assert.equal(plan.links.length, 2, kind);
    }
});
