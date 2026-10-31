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

test('简化规则显式启用且不能暗含旧高级约束，转换不修改原版本',async()=>{
 const {simplifyConversationTurn}=await import('@/lib/evaluation-conversation');
 const [old]=normalizeConversationTurns({input:'q',turns:[{input:'q',expectedOutput:'旧参考',expectation:{contains:'应包含',pattern:'x',state:'submitted',fields:[{path:'status'}],toolOrder:['check'],requiredTools:[{name:'check'}],expectedSkill:'loan'}}]});
 const frozen=structuredClone(old),simple=simplifyConversationTurn(old);
 assert.deepEqual(old,frozen);assert.equal(simple.expectedOutput,'应包含');assert.equal(simple.expectation.outputMatch,'contains');
 assert.equal(simple.expectation.state,undefined);assert.deepEqual(simple.expectation.fields,[]);assert.deepEqual(simple.expectation.requiredTools,old.expectation.requiredTools);
 assert.doesNotThrow(()=>normalizeConversationTurns({input:'q',turns:[simple]}));
 for(const advanced of [{contains:'x'},{pattern:'x'},{state:'done'},{fields:[{path:'x'}]},{toolOrder:['x']}])assert.throws(()=>normalizeConversationTurns({input:'q',turns:[{input:'q',expectation:{outputMatch:'contains',...advanced}}]}));
});
