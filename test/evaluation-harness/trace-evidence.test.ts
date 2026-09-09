import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentCallTree } from '../../src/lib/engine/observability/agent-trace';
import { attachToolResults, linkedToolResultIndices, loadedSkillDefinitions } from '../../src/lib/evaluation-harness/trace-evidence';

const call = (id: string, output?: unknown) => ({ id, function: { name: 'approve_loan', arguments: '{}' }, ...(output !== undefined ? { output } : {}) });

test('links same-name tool results by call id without moving messages or replacing an explicit output', () => {
  const source: any[] = [
    { role: 'assistant', content: '调用审批工具', tool_calls: [call('first'), call('second'), call('recorded', { state: 'kept' })] },
    { role: 'tool', tool_call_id: 'second', content: '{"state":"declined"}' },
    { role: 'tool', tool_call_id: 'first', content: '{"state":"approved"}' },
    { role: 'tool', tool_call_id: 'recorded', content: '{"state":"ignored"}' },
    { role: 'tool', tool_call_id: 'unknown', content: 'unmatched' },
  ];
  const result = attachToolResults(source);
  assert.equal(result.length, source.length);
  assert.equal(result[0].tool_calls[0].output, '{"state":"approved"}');
  assert.equal(result[0].tool_calls[1].output, '{"state":"declined"}');
  assert.deepEqual(result[0].tool_calls[2].output, { state: 'kept' });
  assert.equal(source[0].tool_calls[0].output, undefined);
  assert.equal(result[4], source[4]);
  assert.deepEqual(linkedToolResultIndices(source, 0), [1, 2, 3]);
  const tools = buildAgentCallTree(result)!.events.filter(event => event.kind === 'tool');
  assert.equal(tools.length, 3);
  assert.equal(tools[0].output, '{"state":"approved"}');
});

test('an id reused by a later assistant does not link the later result to the earlier call', () => {
  const source: any[] = [
    { role: 'assistant', content: '第一次', tool_calls: [call('same')] },
    { role: 'assistant', content: '第二次', tool_calls: [call('same')] },
    { role: 'tool', tool_call_id: 'same', content: 'second output', _payloadDeferred: true },
  ];
  assert.deepEqual(linkedToolResultIndices(source, 0), []);
  assert.deepEqual(linkedToolResultIndices(source, 1), [2]);
  const result = attachToolResults(source);
  assert.equal(result[0].tool_calls[0].output, undefined);
  assert.equal(result[1].tool_calls[0].output, 'second output');
});

test('loaded definitions keep external versions and hashes without creating Skill tool calls', () => {
  const loaded = { skillId: 'loan_approval', skillVersion: 'baseline', definitionHash: 'hash-1' };
  const source: any[] = [
    { role: 'assistant', content: '请提供风险等级', metadata: { evaluation: { loadedSkills: [loaded] } } },
    { role: 'assistant', content: '已审批', metadata: { evaluation: { loadedSkills: [loaded, { ...loaded, skillVersion: 'fixed', definitionHash: 'hash-2' }, { skillId: 'invalid' }] } } },
  ];
  assert.deepEqual(loadedSkillDefinitions(source), [
    { name: 'loan_approval', externalVersion: 'baseline', definitionHash: 'hash-1' },
    { name: 'loan_approval', externalVersion: 'fixed', definitionHash: 'hash-2' },
  ]);
  const tree = buildAgentCallTree(attachToolResults(source))!;
  assert.equal(tree.stats.skillCalls, 0);
  assert.equal(tree.stats.toolCalls, 0);
  assert.equal(tree.events.some(event => event.kind === 'skill'), false);
});
