import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeConversationTurns, projectConversationCase, toExecutionConversation, executionConversationSchema } from '@/lib/evaluation-conversation';

test('旧单轮 Case 保持原输入预期，多轮投影为首输入与末预期', () => {
  const legacy={id:'old',input:'起始问题',expectedOutput:'最后答案'};
  assert.equal(normalizeConversationTurns(legacy).length,1);
  assert.deepEqual(projectConversationCase(legacy),legacy);
  const multi={...legacy,turns:[{input:'记住秘密',expectedOutput:'好的'},{input:'秘密是什么',expectedOutput:'随机值'}]};
  const projected=projectConversationCase(multi);
  assert.equal(projected.input,'记住秘密');assert.equal(projected.expectedOutput,'随机值');
  assert.equal(projected.turns.length,2);
});

test('执行合同只发送轮次和输入，不能泄漏答案与规则', () => {
  const turns=normalizeConversationTurns({input:'',expectedOutput:'',turns:[{id:'one',input:'a',expectedOutput:'secret-answer',expectation:{contains:'secret-rule'}},{id:'two',input:'b'}]});
  const request=toExecutionConversation(turns);
  assert.deepEqual(request,{version:1,turns:[{id:'one',input:'a'},{id:'two',input:'b'}]});
  assert.equal(JSON.stringify(request).includes('secret'),false);
  assert.throws(()=>executionConversationSchema.parse({version:1,turns:[{id:'one',input:'a',expectedOutput:'hidden'}]}));
});

test('非法逐轮定义不能退化成一条单轮任务', () => {
  for(const turns of [[],[{input:''}],Array.from({length:21},()=>({input:'x'})),[{id:'same',input:'a'},{id:'same',input:'b'}]])assert.throws(()=>normalizeConversationTurns({input:'valid',expectedOutput:'',turns}));
  assert.throws(()=>normalizeConversationTurns({input:'',expectedOutput:'',turns:[{input:'a',expectation:{requiredTools:[{name:'pay'}],forbiddenTools:['pay']}}]}));
});
