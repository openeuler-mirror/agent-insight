import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, parseEvent, strictJson, validTime, type Binding, type RelationEvent } from '../src/lib/collaboration/contracts';
import { extractCalls, resolveAnchors, type Call, type Trace } from '../src/lib/collaboration/resolve';

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
