import test from 'node:test';
import assert from 'node:assert/strict';
import { replayTurns } from '../../src/lib/evaluation-harness/replay';
import { caseSchema } from '../../src/lib/evaluation-harness/domain';
import { evaluateRules } from '../../src/lib/evaluation-harness/rules';

test('replay separates user turns and retains observed tool arguments in order', () => {
  const turns = replayTurns([
    { role: 'system', content: 'system' },
    { role: 'user', content: '申请' },
    { role: 'assistant', content: '金额？' },
    { role: 'user', content: '8万' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'review', arguments: '{"amount":80000}' } }] },
    { role: 'tool', tool_call_id: 't1', content: '{"ok":true}' },
    { role: 'assistant', content: '转人工', metadata: { evaluation: { skill: 'loan', state: 'pending' } } },
  ]);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].output, '金额？');
  assert.equal(turns[1].input, '8万');
  assert.equal(turns[1].skill, 'loan');
  assert.equal(turns[1].tools?.[0].arguments.amount, 80000);
  assert.deepEqual(turns[1].tools?.[0].result, { ok: true });
});

test('replay does not infer missing tools, skill, or state from plain assistant text', async () => {
  const evidence = replayTurns([{ role: 'user', content: 'hi' }, { role: 'assistant', content: '调用 loan，状态 done' }]);
  assert.equal(evidence[0].skill, undefined);
  assert.equal(evidence[0].state, undefined);
  assert.equal(evidence[0].tools, undefined);
  const c=caseSchema.parse({id:'c',name:'c',turns:[{input:'hi',expectation:{expectedSkill:'loan',state:'done',forbiddenTools:['approve']}}]});
  assert.equal((await evaluateRules(c,evidence)).verdict,'unknown');
});

test('replay with an explicitly recorded empty tool list can prove no tool was called', () => {
  const e=replayTurns([{role:'user',content:'hi'},{role:'assistant',content:'ok',tool_calls:[]}]);
  assert.deepEqual(e[0].tools,[]);
});

test('replay excludes trailing user turns without any assistant response', () => {
  assert.deepEqual(replayTurns([{role:'user',content:'hi'}]),[]);
});
