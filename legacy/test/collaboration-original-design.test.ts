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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { CollaborationStore, sqlDatabase } from '../src/lib/collaboration/store';
import { CollaborationService } from '../src/lib/collaboration/service';
import { createCollaborationHandlers } from '../src/lib/collaboration/http';

 test('original design: events alone, late Trace, repeated and cyclic edges, native evidence and owner isolation', async () => {
    const url = `file:${join(await mkdtemp(join(tmpdir(), 'collaboration-original-')), 'test.db')}`;
    const setup = spawnSync('node_modules/.bin/prisma', ['db', 'push', '--skip-generate'], { env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, encoding: 'utf8' });
    assert.equal(setup.status, 0, setup.stderr);
    const client = new PrismaClient({ datasources: { db: { url } } });
    const store = new CollaborationStore(sqlDatabase(client));
    const service = new CollaborationService(store);
    const handlers = createCollaborationHandlers({ service, authenticate: async key => key === 'alice-key' ? 'alice' : key === 'bob-key' ? 'bob' : null });
    const request = (body?: unknown, key = 'alice-key') => new Request('http://localhost/api', { method: body ? 'POST' : 'GET', headers: { 'x-witty-api-key': key, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const event = (id: string, from = 'A', to = 'B', extra = {}) => ({ collaborationId: 'demo', eventId: id, fromSessionId: from, toSessionId: to, description: '传递结果', ...extra });
    const addTrace = async (taskId: string, calls: unknown[], alias = taskId, user = 'alice') => {
        await client.session.create({ data: { taskId, user, interactions: JSON.stringify([{ role: 'assistant', agent: taskId, content: '执行原文', tool_calls: calls }]) } });
        await client.execution.create({ data: { id: `exec-${taskId}`, taskId, agentSessionId: alias, user, framework: 'opencode' } });
    };
    const call = (id: string, name: string, args: unknown, output?: unknown) => ({ id, function: { name, arguments: JSON.stringify(args) }, output });
    try {
        assert.equal((await handlers.report(request(event('first')))).status, 201);
        assert.equal((await handlers.report(request(event('first')))).status, 200);
        const empty = await service.graph('alice', 'demo');
        assert.equal(empty.nodes.length, 2); assert.equal(empty.events.length, 1);
        assert.ok(empty.nodes.every(node => node.traceResolution === 'unresolved'));
        assert.equal(empty.events[0].fromAnchor.status, 'not_provided');
        assert.equal(await client.session.count(), 0);
        assert.equal(await client.collaborationSessionBinding.count(), 0);
        assert.equal((await handlers.graph(request(undefined, 'bob-key'), 'demo')).status, 404);
        await handlers.report(request(event('second', 'A', 'B', { fromLocator: { recordType: 'tool', name: 'bash' } })));
        await handlers.report(request(event('cycle', 'B', 'A')));
        await handlers.report(request(event('self', 'A', 'A')));
        const firstPage = await service.graph('alice', 'demo', 0, 1);
        assert.equal(firstPage.total, 4); assert.equal(firstPage.events.length, 1); assert.equal(firstPage.nextOffset, 1);
        await addTrace('task-A', [call('bash-a', 'bash', { command: 'custom-worker' })], 'A');
        await addTrace('task-B', [call('read-b', 'read_file', { path: 'code.ts' })], 'B');
        const late = await service.graph('alice', 'demo');
        assert.equal(late.events.length, 4);
        assert.ok(late.nodes.every(node => node.traceResolution === 'resolved'));
        assert.equal(late.nodes.find(node => node.sessionId === 'A')?.traceSessionId, 'task-A');
        assert.equal(late.events.find(edge => edge.eventId === 'second')?.fromAnchor.status, 'candidate');
        assert.equal(await client.collaborationSessionBinding.count(), 0);
        await addTrace('root', [call('spawn-1', 'task', { session_id: 'middle' })]);
        await addTrace('middle', [call('spawn-2', 'task', { session_id: 'leaf' })]);
        await addTrace('leaf', [call('leaf-read', 'read_file', { path: 'file' })]);
        const native = await service.nativeGraph('alice', 'root');
        assert.equal(native.events.length, 0);
        assert.deepEqual(native.automaticEvents.map(edge => [edge.fromSessionId, edge.toSessionId]), [['root', 'middle'], ['middle', 'leaf']]);
        assert.equal(native.nodes.length, 3);
        await addTrace('ses_text_A', []);
        await addTrace('ses_text_B', []);
        await addTrace('text-root', [
            call('text-spawn-1', 'task', { subagent_type: 'explore' }, '<task_metadata>\nsession_id: ses_text_A\n</task_metadata>'),
            call('text-spawn-2', 'task', { subagent_type: 'explore' }, 'task_id: ses_text_B (for resuming)\n<task_result>done</task_result>'),
        ]);
        const textNative = await service.nativeGraph('alice', 'text-root');
        assert.deepEqual(textNative.automaticEvents.filter(edge => edge.fromSessionId === 'text-root').map(edge => edge.toSessionId).sort(), ['ses_text_A', 'ses_text_B']);
        await addTrace('envelope-root', [
            { ...call('envelope', 'task', {}, '<task id="ses_text_A" state="completed">\n<task_result>done</task_result>\n</task>') },
            { ...call('metadata', 'task', {}, 'plain result'), state: { status: 'completed', metadata: { sessionId: 'ses_text_B', parentSessionId: 'envelope-root' } } },
        ]);
        const envelopeNative = await service.nativeGraph('alice', 'envelope-root');
        assert.deepEqual(envelopeNative.automaticEvents.map(edge => edge.toSessionId).sort(), ['ses_text_A', 'ses_text_B']);
        await addTrace('failed-text-root', [
            { ...call('failed-text', 'task', {}, '<task_metadata>\nsession_id: ses_text_A\n</task_metadata>'), state: 'error' },
        ]);
        assert.equal((await service.nativeGraph('alice', 'failed-text-root')).automaticEvents.length, 0);
        await addTrace('ambiguous-text-root', [
            call('ambiguous-text', 'task', { session_id: 'ses_text_A' }, '<task_metadata>\nsession_id: ses_text_B\n</task_metadata>'),
        ]);
        assert.equal((await service.nativeGraph('alice', 'ambiguous-text-root')).automaticEvents.length, 0);
        await addTrace('pending-text-root', [call('pending-text', 'task', {}, 'task_id: ses_late_child (for resuming)')]);
        const pendingText = await service.nativeGraph('alice', 'pending-text-root');
        assert.equal(pendingText.automaticEvents.length, 1);
        assert.equal(pendingText.nodes.find(node => node.sessionId === 'ses_late_child')?.traceResolution, 'unresolved');
        await addTrace('ses_late_child', []);
        assert.equal((await service.nativeGraph('alice', 'pending-text-root')).nodes.find(node => node.sessionId === 'ses_late_child')?.traceResolution, 'resolved');
        assert.equal(await client.collaborationEvent.count(), 4);
        await assert.rejects(service.nativeGraph('bob', 'root'), /不存在或无权/);
        await handlers.report(request(event('native-report', 'root', 'middle')));
        const merged = await service.graph('alice', 'demo');
        assert.deepEqual(merged.events.find(edge => edge.eventId === 'native-report')?.sources, ['reported', 'trace']);
        assert.equal(merged.automaticEvents.filter(edge => edge.fromSessionId === 'root').length, 0);
        await addTrace('other-A', [], 'A');
        const ambiguous = await service.graph('alice', 'demo');
        assert.equal(ambiguous.nodes.find(node => node.sessionId === 'A')?.traceResolution, 'unresolved');
        assert.match(ambiguous.nodes.find(node => node.sessionId === 'A')?.message || '', /多个/);
        assert.equal(ambiguous.events.length, 5);
        assert.equal(await client.execution.count({ where: { isSubagent: true } }), 0);
        await addTrace('bound-parent', [call('wrong-target', 'task', { session_id: 'worker' })]);
        await addTrace('worker', []);
        await addTrace('actual-worker', [], 'native-worker');
        await store.bind('alice', { collaborationId: 'bound-alias', sessionId: 'worker', traceSessionId: 'actual-worker', eventClock: 'unknown' });
        await store.saveEvent('alice', { ...event('bound-report', 'bound-parent', 'worker'), collaborationId: 'bound-alias' });
        const bound = await service.graph('alice', 'bound-alias');
        assert.equal(bound.events[0].fromAnchor.status, 'not_provided');
        assert.deepEqual(bound.events[0].sources, ['reported']);
        assert.equal(bound.automaticEvents.some(edge => edge.fromSessionId === 'bound-parent'), false);
        await addTrace('native-parent', [call('native-target', 'task', { session_id: 'native-worker' })]);
        await store.saveEvent('alice', { ...event('native-alias-report', 'native-parent', 'native-worker'), collaborationId: 'native-alias' });
        const nativeAlias = await service.graph('alice', 'native-alias');
        assert.equal(nativeAlias.events[0].fromAnchor.status, 'confirmed');
        assert.equal(nativeAlias.nodes.find(node => node.sessionId === 'native-worker')?.traceSessionId, 'actual-worker');
        await store.bind('alice', { collaborationId: 'native-alias', sessionId: 'native-worker', traceSessionId: 'actual-worker', eventClock: 'unknown' });
        assert.equal((await service.graph('alice', 'native-alias')).events[0].fromAnchor.status, 'confirmed');
    } finally { await client.$disconnect(); }
});
