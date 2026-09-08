import test from 'node:test';
import assert from 'node:assert/strict';
import { validateComparison, compareCaseVerdicts } from '../../src/lib/evaluation-harness/comparison';
const agent = {id:'a1',assetKey:'agent',name:'Agent',version:1,content:{type:'agent'}};
const skill = {id:'s1',assetKey:'skill',name:'Skill',version:1,content:{type:'skill'}};
test('comparison rejects equal variants and Skill comparisons across different Skills', () => {
 assert.throws(()=>validateComparison({dimension:'agent',targetBId:'a1'},agent,agent,['e1']),/不同/);
 assert.throws(()=>validateComparison({dimension:'skill',targetBId:'s2'},skill,{...skill,id:'s2',assetKey:'other'},['e1']),/同一 Skill/);
 assert.throws(()=>validateComparison({dimension:'llm',modelA:'m',modelB:'m'},agent,null,['e1']),/不同/);
 assert.throws(()=>validateComparison({dimension:'evaluator',evaluatorBIds:['e1']},agent,null,['e1']),/不同/);
 assert.doesNotThrow(()=>validateComparison({dimension:'agent',targetBId:'a2'},agent,{...agent,id:'a2'},['e1']));
});
test('unknown results are excluded from paired deltas and never become zero',()=>{
 assert.deepEqual(compareCaseVerdicts('unknown','pass'),{comparable:false,delta:null,label:'未评完整'});
 assert.deepEqual(compareCaseVerdicts('fail','pass'),{comparable:true,delta:100,label:'B 改善'});
 assert.equal(compareCaseVerdicts('pass','fail','evaluator').label,'判定不同');
 assert.equal(compareCaseVerdicts('pass','pass','evaluator').label,'判定一致');
});

test('each comparison accepts only its selected variable', async () => {
 const { comparisonSchema } = await import('../../src/lib/evaluation-harness/comparison');
 for (const config of [
  {dimension:'agent',targetBId:'a2',evaluatorBIds:['e2']},
  {dimension:'evaluator',evaluatorBIds:['e2'],targetBId:'a2'},
  {dimension:'llm',modelA:'a',modelB:'b',datasetBId:'d2'},
  {dimension:'dataset',datasetBId:'d2',targetBId:'a2'},
  {dimension:'skill',targetBId:'s2',modelB:'b'},
 ]) assert.equal(comparisonSchema.safeParse(config).success,false,JSON.stringify(config));
 assert.equal(comparisonSchema.safeParse({dimension:'dataset',datasetBId:'d2',caseBIds:['x']}).success,true);
 assert.equal(comparisonSchema.safeParse({dimension:'dataset',datasetBId:'d2',caseBIds:['x','x']}).success,false);
});

test('dataset comparison rejects the same version and missing B dataset', () => {
 const data={id:'d1'};
 assert.throws(()=>validateComparison({dimension:'dataset',datasetBId:'d1'} as any,agent,null,['e1'],data,data),/不同/);
 assert.throws(()=>validateComparison({dimension:'dataset',datasetBId:'d2'} as any,agent,null,['e1'],data,null),/评测集/);
 assert.doesNotThrow(()=>validateComparison({dimension:'dataset',datasetBId:'d2'} as any,agent,null,['e1'],data,{id:'d2'}));
});

test('dataset pairs retain unmatched cases and exclude changed definitions from deltas', async () => {
 const { buildDatasetPairs } = await import('../../src/lib/evaluation-harness/comparison');
 const make=(id:string,input:string,expectedOutput='完成',v='pass')=>({rowId:id,case:{id,name:id,turns:[{input,expectedOutput,expectation:{}}]},verdict:v});
 const a=[make('same','同输入'),make('changed','旧输入'),make('removed','删除')];
 const b=[make('same','同输入','完成','fail'),make('changed','新输入'),make('added','新增')];
 const pairs=buildDatasetPairs(a,b,true);
 assert.equal(pairs.length,4);
 assert.equal(pairs[0].comparable,true);assert.equal(pairs[0].delta,-100);assert.equal(pairs[0].label,'判定不同');
 assert.equal(pairs[1].matchStatus,'changed');assert.equal(pairs[1].comparable,false);assert.equal(pairs[1].delta,null);
 assert.equal(pairs[2].matchStatus,'a-only');assert.equal(pairs[2].b,undefined);
 assert.equal(pairs[3].matchStatus,'b-only');assert.equal(pairs[3].a,undefined);
 const ruleChange=buildDatasetPairs([make('a','输入')],[make('b','输入','另一预期')],false);
 assert.equal(ruleChange[0].matchStatus,'changed');assert.equal(ruleChange[0].delta,null);
 const fullTurnsA={...make('multi','第一轮'),case:{id:'multi',name:'multi',turns:[{input:'第一轮',expectedOutput:''},{input:'旧第二轮',expectedOutput:''}]}};
 const fullTurnsB={...make('multi','第一轮'),case:{id:'multi',name:'multi',turns:[{input:'第一轮',expectedOutput:''},{input:'新第二轮',expectedOutput:''}]}};
 assert.equal(buildDatasetPairs([fullTurnsA],[fullTurnsB],false).length,2);
});

test('Agent and Skill comparisons preserve declared shared modules',()=>{
 assert.throws(()=>validateComparison({dimension:'agent',targetBId:'a2'}, {...agent,content:{type:'agent',model:'one'}},{...agent,id:'a2',content:{type:'agent',model:'two'}},['e1']),/模型/);
 assert.throws(()=>validateComparison({dimension:'agent',targetBId:'a2'}, {...agent,content:{type:'agent',skills:[{name:'one'}]}},{...agent,id:'a2',content:{type:'agent',skills:[{name:'two'}]}},['e1']),/Skill/);
 assert.throws(()=>validateComparison({dimension:'skill',targetBId:'s2'}, {...skill,content:{type:'skill',model:'one'}},{...skill,id:'s2',content:{type:'skill',model:'two'}},['e1']),/模型/);
});

test('Skill comparisons keep the same execution adapter and endpoint',()=>{
 const a={...skill,content:{type:'skill',adapter:'http',endpoint:'http://one',externalId:'skill'}};
 for(const changed of [{endpoint:'http://two'},{adapter:'demo'},{externalId:'other'},{credentialId:'another-tenant'}]) assert.throws(()=>validateComparison({dimension:'skill',targetBId:'s2'},a,{...a,id:'s2',content:{...a.content,...changed}},['e1']),/执行接入/);
});

test('cross-dataset duplicate inputs reserve exact definitions before pairing changed rules',async()=>{
 const { buildDatasetPairs } = await import('../../src/lib/evaluation-harness/comparison');
 const row=(id:string,expectedOutput:string)=>({rowId:id,case:{id,name:'同一业务 Case',turns:[{input:'相同输入',expectedOutput,expectation:{}}]},verdict:'pass' as const});
 const a=[row('a-rule1','规则1'),row('a-rule2','规则2')];
 const b=[row('b-rule2','规则2')];
 const pairs=buildDatasetPairs(a,b,false);
 assert.deepEqual(pairs.map(p=>p.matchStatus),['a-only','matched']);
 assert.equal(pairs[0].b,undefined);
 assert.equal(pairs[1].b?.case.id,'b-rule2');
 assert.equal(pairs[1].comparable,true);
 const remaining=buildDatasetPairs(a,[row('b-rule2','规则2'),row('b-rule3','规则3')],false);
 assert.deepEqual(remaining.map(p=>p.matchStatus),['changed','matched']);
 assert.equal(remaining[0].b?.case.id,'b-rule3');
 const sameAsset=buildDatasetPairs([row('stable-id','规则1')],[row('stable-id','规则2'),row('other-id','规则1')],true);
 assert.deepEqual(sameAsset.map(p=>p.matchStatus),['changed','b-only']);
});


test('dataset definitions include the business notes and metadata passed to an LLM judge',async()=>{
 const { buildDatasetPairs } = await import('../../src/lib/evaluation-harness/comparison');
 const a={rowId:'a',case:{id:'a',name:'审批要求',note:'重点检查审批前人工复核',category:'positive' as const,difficulty:'medium' as const,tags:['审批'],turns:[{input:'申请贷款',expectedOutput:'复核',expectation:{}}]},verdict:'pass' as const};
 const b={...a,rowId:'b',case:{...a.case,id:'b'}};
 assert.equal(buildDatasetPairs([a],[b],false)[0].comparable,true);
 for(const metadata of [{note:'只检查有无回复'},{name:'无需审批的咨询'},{category:'negative' as const},{difficulty:'hard' as const},{tags:['跳过复核']}]){
  const pair=buildDatasetPairs([a],[{...b,case:{...b.case,...metadata}}],false)[0];
  assert.equal(pair.matchStatus,'changed',JSON.stringify(metadata));
  assert.equal(pair.comparable,false);assert.equal(pair.delta,null);
 }
});

test('Skill comparison can bind two Skill versions to one explicit Agent',async()=>{
 const {comparisonSchema}=await import('../../src/lib/evaluation-harness/comparison');
 const config={dimension:'skill' as const,skillAId:'s1',skillBId:'s2'};
 const a={...skill,content:{type:'skill',externalId:'review',endpoint:'http://ignored-a',model:'ignored-a'}};
 const b={...a,id:'s2',content:{...a.content,endpoint:'http://ignored-b',model:'ignored-b'}};
 assert.equal(comparisonSchema.safeParse(config).success,true);
 assert.doesNotThrow(()=>validateComparison(config,agent,null,['e1'],undefined,undefined,a,b));
 assert.throws(()=>validateComparison(config,skill,null,['e1'],undefined,undefined,a,b),/执行 Agent/);
 assert.throws(()=>validateComparison(config,agent,null,['e1'],undefined,undefined,a,{...b,assetKey:'other'}),/同一 Skill/);
 assert.throws(()=>validateComparison(config,agent,null,['e1'],undefined,undefined,a,{...b,content:{...b.content,externalId:'other'}}),/同一 Skill/);
 assert.equal(comparisonSchema.safeParse({...config,targetBId:'legacy'}).success,false);
 assert.equal(comparisonSchema.safeParse({dimension:'skill',skillAId:'s1'}).success,false);
});
