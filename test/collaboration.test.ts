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
import { canonical, parseEvent, strictJson, validTime, type Binding, type RelationEvent } from '../src/lib/collaboration/contracts';
import { extractCalls, resolveAnchors, type Call, type Trace } from '../src/lib/collaboration/resolve';
import { buildAgentCallTree, type RawInteraction } from '../src/lib/engine/observability/agent-trace';
import { composeCollaborationTrace } from '../src/lib/ingest/collaboration/trace-projection';

const event = (id: string, to = id, extra: Partial<RelationEvent> = {}): RelationEvent => ({ collaborationId: 'c', eventId: id, fromSessionId: 'A', toSessionId: to, description: '调用', fromLocator: { recordType: 'tool', name: 'spawn_agent' }, observedAt: `2026-09-11T10:00:0${id === '1' ? '1' : '2'}Z`, ...extra });
const call = (id: string, at = Number(id)): Call => ({ key: id, recordId: id, interactionIndex: 0, callIndex: Number(id), name: 'spawn_agent', targets: [], failed: false, startedAt: at, timeSource: 'execution' });
const binding: Binding = { collaborationId: 'c', sessionId: 'A', traceSessionId: 'native-A', eventClock: 'source_session' };
function resolve(events: RelationEvent[], calls: Call[], bindings = [binding]) {
    return resolveAnchors(events, new Map(bindings.map(b => [b.sessionId, b])), new Map<string, Trace>([['A', { state: 'resolved', calls }]]));
}
test('strict JSON rejects duplicate decoded keys, trailing commas, null locator and mixed fields', () => {
    for (const input of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"o":{"a":1,"a":2}}', '[1,]', '{"a":1,}', '{}{}']) assert.throws(() => strictJson(input));
    assert.equal(canonical(strictJson('{"b":2,"a":{"b":1}}')), '{"a":{"b":1},"b":2}');
    assert.throws(() => parseEvent({ ...event('1'), fromLocator: null }));
    assert.throws(() => parseEvent({ ...event('1'), fromLocator: { recordType: 'tool', name: 'x', commandContains: 'x' } }));
    assert.throws(() => parseEvent({ ...event('1'), unknown: true }));
    assert.throws(() => parseEvent({ ...event('1'), content: null }));
    assert.throws(() => parseEvent({ ...event('1'), collaborationId: 'collab_gp_reserved' }));
    assert.equal(validTime('2026-02-30T10:00:00Z'), false);
    assert.equal(validTime('2026-09-11T10:00:00'), false);
    assert.equal(validTime('2026-09-11T10:00:00.001+08:00'), true);
});
test('one name match is candidate, not confirmed; description has no influence', () => {
    assert.equal(resolve([event('1', 'B', { description: '确定调用 B' })], [call('1')]).get('1')?.status, 'candidate');
});
test('out of order events pair in observed time order', () => {
    const result = resolve([event('2'), event('1')], [call('2'), call('1')]);
    assert.equal(result.get('1')?.status, 'time_ordered');
    assert.equal(result.get('1')?.matchedRecord?.recordId, '1');
    assert.equal(result.get('2')?.orderIndex, 2);
});
test('missing time, tied time, unknown clock, failed calls and one-to-many prevent ordering', () => {
    const events = [event('1'), event('2')];
    for (const calls of [[call('1'), call('2', 1)], [call('1'), { ...call('2'), startedAt: undefined }], [call('1'), { ...call('2'), failed: true }], [call('1'), { ...call('2'), targets: ['B', 'C'] }]]) {
        assert.equal(resolve(events, calls).get('1')?.status, 'ambiguous');
    }
    assert.equal(resolve(events, [call('1'), call('2')], [{ ...binding, eventClock: 'unknown' }]).get('1')?.status, 'ambiguous');
    assert.equal(resolve([event('1'), event('2', '2', { observedAt: event('1').observedAt })], [call('1'), call('2')]).get('1')?.status, 'ambiguous');
});
test('late extra call retracts inferred anchors', () => {
    const events = [event('1'), event('2')];
    assert.equal(resolve(events, [call('1'), call('2')]).get('1')?.status, 'time_ordered');
    assert.equal(resolve(events, [call('0'), call('1'), call('2')]).get('1')?.status, 'ambiguous');
});
test('explicit target evidence wins over conflicting order and respects locator', () => {
    const bindings = [binding, { ...binding, sessionId: 'B', traceSessionId: 'native-B' }];
    const calls = [call('1'), { ...call('2'), targets: ['native-B'] }];
    const result = resolve([event('1', 'B'), event('2', 'C')], calls, bindings);
    assert.equal(result.get('1')?.status, 'confirmed');
    assert.equal(result.get('1')?.matchedRecord?.recordId, '2');
    assert.equal(result.get('2')?.status, 'ambiguous');
    assert.equal(resolve([event('1', 'B', { fromLocator: { recordType: 'tool', name: 'other' } })], calls, bindings).get('1')?.status, 'not_found');
});
test('a logical binding alias is not evidence that the original call targeted its bound Trace', () => {
    const bindings = [binding, { ...binding, sessionId: 'worker', traceSessionId: 'actual-worker' }];
    const calls = [{ ...call('1'), targets: ['worker'] }];
    assert.equal(resolve([event('1', 'worker')], calls, bindings).get('1')?.status, 'candidate');
});
test('overlapping shell/tool groups do not assign the same call twice', () => {
    const calls = [call('1'), call('2')].map(c => ({ ...c, command: 'run-agent' }));
    const events = [event('1'), event('2'), event('3', 'D', { fromLocator: { recordType: 'shell', commandContains: 'run-agent' } }), event('4', 'E', { fromLocator: { recordType: 'shell', commandContains: 'run-agent' } })];
    assert.ok([...resolve(events, calls).values()].every(a => a.status === 'ambiguous'));
});
test('tool time does not borrow interaction time, OpenCode part enriches matching tool id', () => {
    const interactions = [{ role: 'assistant', timestamp: 999, tool_calls: [{ id: 'c1', function: { name: 'spawn_agent', arguments: '{}' }, timing: { started_at: 999 } }], parts: [{ type: 'tool', tool: 'spawn_agent', callID: 'c1', state: { time: { start: 1234 }, input: {} } }] }];
    assert.equal(extractCalls(interactions, 'A', 'generic')[0].startedAt, undefined);
    const calls = extractCalls(interactions, 'A', 'opencode');
    assert.equal(calls.length, 1); assert.equal(calls[0].startedAt, 1234);
    assert.equal(extractCalls([{ role: 'subagent', subagent_session_id: 'B', tool_calls: interactions[0].tool_calls }], 'A').length, 0);
});

test('OpenCode native graph resolves parallel children from task output metadata', () => {
    const interactions = [{ role: 'assistant', tool_calls: [
        { id: 'old-task', function: { name: 'task', arguments: '{"subagent_type":"explore"}' }, state: 'completed', output: 'result\n\n<task_metadata>\nsession_id: ses_child_A\n</task_metadata>' },
        { id: 'new-task', function: { name: 'task', arguments: '{"subagent_type":"explore"}' }, state: 'completed', output: 'task_id: ses_child_B (for resuming this task)\n\n<task_result>done</task_result>' },
    ] }];
    assert.deepEqual(extractCalls(interactions, 'root', 'opencode').map(c => c.targets), [['ses_child_A'], ['ses_child_B']]);
    assert.deepEqual(extractCalls(interactions, 'root', 'generic').map(c => c.targets), [[], []]);
});

test('OpenCode text targets preserve ambiguity, failures and original part positions', () => {
    const interactions = [{ role: 'assistant', parts: [
        { type: 'text', text: 'dispatch' },
        { type: 'tool', tool: 'task', callID: 'part-task', state: { status: 'error', input: { session_id: 'ses_A' }, output: '<task_metadata>\nsession_id: ses_B\n</task_metadata>' } },
    ] }];
    const [call] = extractCalls(interactions, 'root', 'opencode');
    assert.deepEqual(new Set(call.targets), new Set(['ses_A', 'ses_B']));
    assert.equal(call.failed, true);
    assert.equal(call.callIndex, 1);
    assert.equal(call.recordSource, 'parts');
});

test('OpenCode task results and ordinary tool output cannot invent child relationships', () => {
    const output = 'task_id: ses_real (for resuming)\n<task_result>\nsession_id: ses_quoted\n<task_metadata>\nsession_id: ses_example\n</task_metadata>\n</task_result>';
    const interactions = [{ role: 'assistant', tool_calls: [
        { id: 'task', function: { name: 'task', arguments: '{}' }, output },
        { id: 'read', function: { name: 'read', arguments: '{}' }, output },
        { id: 'prose', function: { name: 'task', arguments: '{}' }, output: 'The previous session_id: ses_unrelated was mentioned.' },
    ] }];
    assert.deepEqual(extractCalls(interactions, 'root', 'opencode').map(c => c.targets), [['ses_real'], [], []]);
});

test('OpenCode task identifiers must occupy the native header or trailing metadata block', () => {
    const outputs = [
        'Example output:\n```text\ntask_id: ses_quoted (for resuming)\n```',
        'Example output:\n<task_metadata>\nsession_id: ses_quoted\n</task_metadata>\nThis was an example.',
        'Result mentions:\n```text\n<task_metadata>\nsession_id: ses_quoted\n</task_metadata>\n```\n\n<task_metadata>\nsession_id: ses_real\n</task_metadata>',
        '\n task_id: ses_current (for resuming)\n<task_result>\ntask_id: ses_quoted\n</task_result>',
        'task_id: ses_quoted (for resuming)\nExample from the result.\n\n<task_metadata>\nsession_id: ses_real\n</task_metadata>',
    ];
    const interactions = [{ role: 'assistant', tool_calls: outputs.map((output, index) => ({
        id: `boundary-${index}`, function: { name: 'task', arguments: '{}' }, output,
    })) }];
    assert.deepEqual(extractCalls(interactions, 'root', 'opencode').map(c => c.targets), [[], [], ['ses_real'], ['ses_current'], ['ses_quoted', 'ses_real']]);
});

test('OpenCode native task envelopes and structured part metadata retain exact child IDs', () => {
    const output = '<task id="ses_envelope" state="completed">\n<task_result>task_id: ses_quoted</task_result>\n</task>';
    const interactions = [{ role: 'assistant', tool_calls: [
        { id: 'xml', function: { name: 'task', arguments: '{}' }, output },
        { id: 'quoted-xml', function: { name: 'task', arguments: '{}' }, output: `An example:\n${output}` },
    ], parts: [
        { type: 'tool', tool: 'task', callID: 'metadata', state: { status: 'completed', input: {}, metadata: { sessionId: 'ses_metadata', parentSessionId: 'ses_parent' }, output: 'plain result' } },
        { type: 'tool', tool: 'task', callID: 'conflict', state: { status: 'error', input: {}, metadata: { sessionId: 'ses_metadata' }, output } },
    ] }];
    const calls = extractCalls(interactions, 'ses_parent', 'opencode');
    assert.deepEqual(calls.map(c => c.targets), [['ses_envelope'], [], ['ses_metadata'], ['ses_envelope', 'ses_metadata']]);
    assert.equal(calls[3].failed, true);
    assert.deepEqual(extractCalls(interactions, 'ses_parent', 'generic').map(c => c.targets), [[], [], [], []]);
});
test('same call explicitly named by two reports does not prove event identity', () => {
    const result = resolve([event('1', 'B'), event('2', 'B')], [{ ...call('1'), targets: ['native-B'] }], [binding, { ...binding, sessionId: 'B', traceSessionId: 'native-B' }]);
    assert.ok([...result.values()].every(a => a.status === 'ambiguous'));
});


test('part-only positions reference the original parts index and conflicting IDs fail closed', () => {
    const parts = [{ type: 'text', text: 'reasoning' }, { type: 'tool', tool: 'bash', callID: 'x', state: { input: { command: 'run-agent' }, time: { start: 1000 } } }];
    const calls = extractCalls([{ role: 'assistant', parts }], 'A', 'opencode');
    assert.equal(calls[0].recordSource, 'parts'); assert.equal(calls[0].callIndex, 1);
    assert.equal(calls[0].command, 'run-agent');
    assert.throws(() => extractCalls([{ role: 'assistant', parts: [...parts, { ...parts[1], state: { time: { start: 2000 } } }] }], 'A', 'opencode'));
});

test('Goal Plus collaboration projection renders an independent worker as a labelled task subtree', () => {
    const root: RawInteraction[] = [
        { role: 'user', content: '优化目标', timestamp: 1000 },
        { role: 'assistant', agent: 'Goal Plus 主 Agent', content: '开始编排', timestamp: 1100 },
    ];
    const worker: RawInteraction[] = [
        { role: 'user', content: '搜索候选方案', timestamp: 1200 },
        {
            role: 'assistant',
            agent: 'Search Candidate Worker',
            content: '读取候选数据',
            timestamp: 1300,
            tool_calls: [{ id: 'read-candidate', function: { name: 'read_file', arguments: '{}' } }],
        },
        { role: 'assistant', agent: 'Search Candidate Worker', content: '候选搜索完成', timestamp: 1400 },
    ];
    const before = JSON.stringify({ root, worker });
    const projection = composeCollaborationTrace(root, [{
        eventId: 'evt-goal-worker',
        taskId: 'goal-plus:source:worker-1',
        executionId: 'worker-execution',
        agentName: 'Search Candidate Worker',
        interactions: worker,
        description: 'Goal Plus 编排 candidate-worker',
        sourceType: 'goal-plus-semantic',
        relationKind: 'orchestrated',
        anchorState: 'not_provided',
        role: 'candidate-worker',
    }]);
    const tree = buildAgentCallTree(projection.interactions);

    assert.equal(projection.includedMembers, 1);
    assert.equal(tree?.children.length, 1);
    assert.equal(tree?.children[0].agentName, 'Search Candidate Worker');
    assert.equal(tree?.children[0].sessionId, 'goal-plus:source:worker-1');
    assert.equal(tree?.children[0].relation?.sourceType, 'goal-plus-semantic');
    assert.equal(tree?.events.find(item => item.kind === 'task')?.relation?.anchorState, 'not_provided');
    assert.ok(tree?.children[0].events.some(item => item.kind === 'user'));
    assert.ok(tree?.children[0].events.some(item => item.kind === 'tool'));
    assert.equal(JSON.stringify({ root, worker }), before, 'projection must not mutate native interactions');
});
