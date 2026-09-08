import test from 'node:test';
import assert from 'node:assert/strict';
import { caseRerunConfig } from '../../src/lib/evaluation-harness/case-rerun';
const detail = {experiment:{name:'对比',cases:[{id:'row-b',groupId:'b',caseValuesJson:JSON.stringify({id:'case-1',name:'Case'})}]},manifest:{target:{id:'agent'},dataset:{id:'dataset-a'},evaluatorIds:['eval-a'],evaluators:[{id:'eval-a'},{id:'eval-b'}],threshold:90,timeoutSeconds:60,retries:1,groups:[{id:'b',target:{id:'agent-b'},dataset:{id:'dataset-b'},evaluatorIds:['eval-b']}]}};
test('单独重跑数据集 B 组 Case 使用所属组的目标、数据集和评估器',()=>{
  const config=caseRerunConfig(detail,'row-b','run');
  assert.equal(config.targetId,'agent-b');assert.equal(config.datasetId,'dataset-b');assert.deepEqual(config.evaluatorIds,['eval-b']);assert.deepEqual(config.caseIds,['case-1']);assert.equal(config.comparison,undefined);
});
test('新 Skill 对比重跑保留共同 Agent 与两组 Skill，只重跑选中 Case',()=>{
  const comparison={dimension:'skill',skillAId:'skill-v1',skillBId:'skill-v2'};
  const config=caseRerunConfig({...detail,manifest:{...detail.manifest,comparison}},'row-b','run');
  assert.equal(config.targetId,'agent');assert.equal(config.datasetId,'dataset-a');assert.deepEqual(config.evaluatorIds,['eval-a']);assert.deepEqual(config.comparison,comparison);assert.deepEqual(config.caseIds,['case-1']);assert.equal(config.sourceExperimentId,'run');
});
test('找不到 Case 时不能用其他行的执行配置',()=>assert.throws(()=>caseRerunConfig(detail,'missing','run'),/Case 不存在/));
test('LLM 和评估器对比重跑不能丢失模型覆盖或 B 组评估器',()=>{
  for(const comparison of [{dimension:'llm',modelA:'model-a',modelB:'model-b'},{dimension:'evaluator',evaluatorBIds:['eval-b']}]) {
    const config=caseRerunConfig({...detail,manifest:{...detail.manifest,comparison}},'row-b','run');
    assert.equal(config.targetId,'agent');assert.deepEqual(config.comparison,comparison);assert.deepEqual(config.evaluatorIds,['eval-a']);
  }
});
