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
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildCollaborationTraceTree } from '@/lib/collaboration/display-tree';
import { selectedParentAgent, selectedChildAgents, traceRelationsPending, type ParentAgentReference } from '@/lib/trace/parent-agent';
import { ParentAgentCard } from '@/components/observe/ParentAgentCard';
import { walkTree, type AgentNode } from '@/lib/engine/observability/agent-trace';

const interaction = (agent: string) => ({ role: 'assistant', agent, content: `${agent} body` });

test('parent navigation follows logical direct parents even when the display tree is parallel', () => {
    for (const sequential of [false, true]) {
        const items = ['A', 'B', 'C'].map((id, index) => ({ ...interaction(id), _collaboration: {
            taskId: id, index: 0, version: 'v1', parent: index ? ['A', 'B'][index - 1] : undefined,
            sequential, anchor: { status: 'not_provided' as const, message: '' },
        } }));
        const root = buildCollaborationTraceTree(items)!;
        const nodes = new Map<string, AgentNode>();
        walkTree(root, node => { nodes.set(node.id, node); });
        const before = JSON.stringify(root);
        for (const [child, parent] of [['B', 'A'], ['C', 'B']]) {
            const node = [...nodes.values()].find(node => node.sessionId === child)!;
            assert.deepEqual(selectedParentAgent(node, root, nodes, items, 'A'), { state: 'resolved', taskId: parent, agentName: parent });
        }
        assert.equal(selectedParentAgent(root, root, nodes, items, 'A'), null);
        assert.equal(JSON.stringify(root), before, 'parent navigation must not mutate the tree or aggregate statistics');
    }
});

test('standalone worker shows external parent and waiting/conflict states without importing parent interactions', () => {
    const items = [interaction('worker')];
    const root = buildCollaborationTraceTree(items)!;
    const nodes = new Map([[root.id, root]]);
    const states: ParentAgentReference[] = [
        { state: 'resolved', taskId: 'main__task7', agentName: 'Pi', framework: 'pi-agent' },
        { state: 'pending' }, { state: 'ambiguous' }, { state: 'unavailable' },
    ];
    for (const parent of states) {
        assert.deepEqual(selectedParentAgent(root, root, nodes, items, 'worker', parent), parent);
        const html = renderToStaticMarkup(createElement(ParentAgentCard, { parent, locale: 'zh', onNavigate: () => {} }));
        assert.match(html, /父 Agent/);
        assert.equal(html.includes('<button'), parent.state === 'resolved');
    }
    assert.equal(root.children.length, 0);
    assert.match(renderToStaticMarkup(createElement(ParentAgentCard, { parent: null, locale: 'zh' })), /无父 Trace/);
});

test('Goal Plus parent references and Session API recover late data, reject conflicts and isolate owners', async t => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { execFileSync } = await import('node:child_process');
    const { activateIsolatedHome } = await import('./helpers/isolated-home');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'parent-trace-'));
    const restore = activateIsolatedHome(directory);
    const host = process.env.DB_HOST;
    delete process.env.DB_HOST;
    let disconnect = async () => {};
    t.after(async () => { await disconnect(); restore(); if (host !== undefined) process.env.DB_HOST = host; fs.rmSync(directory, { recursive: true, force: true }); });
    fs.writeFileSync(path.join(directory, 'test.db'), '');
    execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { stdio: 'pipe' });
    const { prismaRaw: client } = await import('@/lib/storage/prisma');
    const { collaborationService: service, collaborationTraceProjection: projection } = await import('@/lib/collaboration/runtime');
    const { GET } = await import('@/app/api/observe/session/route');
    disconnect = () => client.$disconnect();
    await client.user.create({ data: { username: 'alice', apiKey: 'parent-test-alice' } });
    await client.user.create({ data: { username: 'bob', apiKey: 'parent-test-bob' } });
    const trace = async (taskId: string, user = 'alice', body = true) => {
        await client.execution.create({ data: { id: taskId, taskId, user, framework: 'pi-agent', agentName: 'Pi' } });
        if (body) await client.session.create({ data: { taskId, user, query: taskId, interactions: JSON.stringify([interaction(taskId)]) } });
    };
    const group = (char: string) => `gp.${char.repeat(32)}`;
    const bind = (collaborationId: string, sessionId: string, traceSessionId: string) => service.store.bind('alice', {
        collaborationId, sessionId, traceSessionId, eventClock: 'source_session',
    });
    const report = (collaborationId: string, eventId = 'start') => service.store.saveEvent('alice', {
        collaborationId, eventId, fromSessionId: 'main', toSessionId: 'worker:one', description: 'worker launch',
    });
    const connect = async (char: string, parent: string, child: string) => {
        await bind(group(char), 'main', parent);
        await bind(group(char), 'worker:one', child);
        await report(group(char));
    };
    const request = (taskId: string, view = 'structure', key = 'parent-test-alice') => GET(new Request(
        `http://localhost/api/observe/session?taskId=${encodeURIComponent(taskId)}&view=${view}`,
        { headers: { 'x-witty-api-key': key } },
    ));

    await trace('worker');
    await bind(group('a'), 'worker:one', 'worker');
    await report(group('a'));
    assert.deepEqual((await (await request('worker')).json()).parentAgent, { state: 'pending' });
    await bind(group('a'), 'main', 'main__task7');
    await trace('main__task7', 'alice', false);
    assert.deepEqual((await projection.plan('alice')).parentAgents?.worker, { state: 'pending' });
    await client.session.create({ data: { taskId: 'main__task7', user: 'alice', query: 'main', interactions: JSON.stringify([interaction('Pi')]) } });
    const expected = { state: 'resolved', taskId: 'main__task7', executionId: 'main__task7', agentName: 'Pi', framework: 'pi-agent', reported: true };
    for (const view of ['structure', 'full']) {
        const payload = await (await request('worker', view)).json();
        assert.deepEqual(payload.parentAgent, expected);
        assert.equal(payload.interactions.length, 1, 'worker body must remain independent');
    }
    await report(group('a'), 'duplicate-evidence');
    assert.deepEqual((await projection.plan('alice')).parentAgents?.worker, expected);
    const mainPayload = await (await request('main__task7')).json();
    assert.equal(mainPayload.parentAgent, null);
    assert.equal(mainPayload.traceRelations.main__task7.children[0].taskId, 'worker');
    assert.equal(mainPayload.traceRelations.worker.parent.taskId, 'main__task7');
    assert.deepEqual(mainPayload.traceRelations.worker.children, []);
    assert.ok(mainPayload.interactions.some((item: { _collaboration?: { taskId: string } }) => item._collaboration?.taskId === 'worker'));
    const spy = t.mock.method(projection, 'plan');
    await request('worker');
    assert.equal(spy.mock.callCount(), 1, 'parent and child queries must share one projection plan');
    spy.mock.restore();
    assert.equal((await request('worker', 'structure', 'parent-test-bob')).status, 403);
    assert.equal((await (await request('worker', 'structure', 'invalid-key')).json()).parentAgent, null);
    assert.deepEqual(Object.keys((await projection.plan('bob')).parentAgents || {}), []);

    await trace('grandchild');
    await connect('b', 'worker', 'grandchild');
    assert.equal((await (await request('grandchild')).json()).parentAgent.taskId, 'worker');
    const middle = await (await request('worker')).json();
    assert.equal(middle.parentAgent.taskId, 'main__task7');
    assert.equal(middle.traceRelations.worker.children[0].taskId, 'grandchild');
    assert.deepEqual(Object.keys(middle.traceRelations).sort(), ['grandchild', 'worker']);
    const raw = await GET(new Request('http://localhost/api/observe/session?taskId=worker&source=raw', { headers: { 'x-witty-api-key': 'parent-test-alice' } }));
    assert.equal((await raw.json()).traceRelations, undefined);

    await bind(group('c'), 'main', 'other-parent');
    await bind(group('c'), 'worker:one', 'worker');
    await report(group('c'));
    const conflicted = await projection.plan('alice');
    assert.deepEqual(conflicted.parentAgents?.worker, { state: 'ambiguous' });
    assert.ok(!conflicted.links.some(link => link.child === 'worker'), 'late conflicting parent cannot create a one-sided link');
    await trace('self');
    await connect('d', 'self', 'self');
    assert.deepEqual((await projection.plan('alice')).parentAgents?.self, { state: 'ambiguous' });
    await trace('cycle-a');
    await trace('cycle-b');
    await connect('e', 'cycle-a', 'cycle-b');
    await connect('f', 'cycle-b', 'cycle-a');
    assert.deepEqual((await projection.plan('alice')).parentAgents?.['cycle-a'], { state: 'ambiguous' });

    await trace('isolated-child');
    await connect('1', 'private-parent', 'isolated-child');
    await trace('private-parent', 'bob');
    const isolated = (await projection.plan('alice')).parentAgents?.['isolated-child'];
    assert.deepEqual(isolated, { state: 'pending' });
    assert.ok(!JSON.stringify(isolated).includes('private-parent'));
    await trace('native-parent');
    await trace('native-child');
    await client.execution.update({ where: { id: 'native-child' }, data: { isSubagent: true, parentExecutionId: 'native-parent' } });
    const nativeChild = await (await request('native-child')).json();
    assert.equal(nativeChild.parentAgent.taskId, 'native-parent');
    assert.deepEqual(nativeChild.traceRelations['native-child'].children, []);
    const nativeParent = await (await request('native-parent')).json();
    assert.equal(nativeParent.traceRelations['native-parent'].children[0].taskId, 'native-child');
    await trace('native-late', 'alice', false);
    await client.execution.update({ where: { id: 'native-late' }, data: { isSubagent: true, parentExecutionId: 'native-parent' } });
    const waitingNative = await (await request('native-parent')).json();
    assert.ok(waitingNative.traceRelations['native-parent'].children.some((child: ParentAgentReference) => child.state === 'pending'));
    await client.session.create({ data: { taskId: 'native-late', user: 'alice', interactions: JSON.stringify([interaction('late')]) } });
    const readyNative = await (await request('native-parent')).json();
    assert.ok(readyNative.traceRelations['native-parent'].children.some((child: ParentAgentReference) => child.state === 'resolved' && child.taskId === 'native-late'));
    await client.execution.update({ where: { id: 'native-parent' }, data: { user: 'bob' } });
    assert.deepEqual((await (await request('native-child')).json()).parentAgent, { state: 'pending' });

    await trace('mcts-root');
    await trace('mcts-child');
    await service.store.saveEvent('alice', { collaborationId: 'mcts.api-navigation', eventId: 'spawn',
        fromSessionId: 'mcts-root', toSessionId: 'mcts-child', description: 'MCTS child' });
    const mctsChild = await (await request('mcts-child')).json();
    assert.equal(mctsChild.parentAgent.taskId, 'mcts-root');
    const mctsRoot = await (await request('mcts-root')).json();
    assert.equal(mctsRoot.traceRelations['mcts-root'].children[0].taskId, 'mcts-child');
    assert.equal(mctsRoot.traceRelations['mcts-child'].parent.taskId, 'mcts-root');

    const failed = t.mock.method(service.store, 'snapshot', async () => { throw new Error('test database unavailable'); });
    const unavailable = await (await request('worker')).json();
    assert.deepEqual(unavailable.parentAgent, { state: 'unavailable' });
    assert.ok(unavailable.interactions.length > 0);
    failed.mock.restore();
});


test('direct children follow logical relations in both anchored and parallel collections without synthetic parents', () => {
    for (const sequential of [false, true]) {
        const items = ['A', 'B', 'C'].map((id, index) => ({ ...interaction(id), _collaboration: {
            taskId: id, index: 0, version: 'v1', parent: index ? ['A', 'B'][index - 1] : undefined, sequential,
        } }));
        const root = buildCollaborationTraceTree(items)!;
        const nodes = new Map<string, AgentNode>();
        walkTree(root, node => { nodes.set(node.id, node); });
        const before = JSON.stringify(root);
        for (const [parent, child] of [['A', 'B'], ['B', 'C'], ['C', null]]) {
            const node = [...nodes.values()].find(node => node.sessionId === parent)!;
            const children = selectedChildAgents(node, root, nodes, items, 'A');
            assert.deepEqual(children.map(ref => ref.state === 'resolved' ? ref.taskId : ref.state), child ? [child] : []);
        }
        if (sequential) {
            assert.equal(selectedParentAgent(root, root, nodes, items, 'A', { state: 'resolved', taskId: 'external', agentName: 'External' }), null);
            assert.equal(selectedChildAgents(root, root, nodes, items, 'A').length, 3);
        }
        assert.equal(JSON.stringify(root), before);
    }
});

test('pending children remain visible without fabricated links and keep completed collections refreshing', () => {
    const items = [interaction('main')];
    const root = buildCollaborationTraceTree(items)!;
    const relations = { main: { parent: null, children: [{ state: 'pending' as const }] } };
    assert.deepEqual(selectedChildAgents(root, root, new Map([[root.id, root]]), items, 'main', relations), [{ state: 'pending' }]);
    assert.equal(traceRelationsPending({ traceRelations: relations }), true);
    assert.equal(traceRelationsPending({ traceRelations: { main: { parent: null, children: [] } } }), false);
    assert.equal(traceRelationsPending({ traceRelations: { main: { parent: null, children: [{ state: 'ambiguous' }] } } }), false);
});
