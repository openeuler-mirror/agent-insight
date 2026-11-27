/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeExperimentAssetVersions, type AnalysisExperimentInput } from '@/lib/evaluation-assets/experiment-analysis';

function run(id:string,version=1,patch:Record<string,unknown>={}):AnalysisExperimentInput {
 const asset=(businessId:string,v=1)=>({businessId,versionId:businessId+v,version:v,contentHash:businessId+v,definition:{name:businessId}});
 return {id,name:id,status:'done',agentName:'build',type:'single',skillName:'finance',skillVersion:1,scope:'',createdAt:'2026-01-01',
  evaluatorIdsJson:'["quality"]',evaluatorConfigsJson:'{}',configSnapshotJson:JSON.stringify({traceSource:'generate',executionTarget:{platform:'opencode',workerId:'client-one',model:'model-one',timeoutSeconds:60,agent:'build'},assetVersions:{schemaVersion:1,agent:asset('agent',version),dataset:{...asset('dataset'),definition:{name:'贷款集',cases:[{id:'case-one'}]}},evaluators:{quality:asset('quality')}}}),
  cases:[{input:'question',referenceOutput:'answer',execution:{model:'model-one',framework:'opencode',clientId:'client-one'},boundAttempt:{workerId:'client-one',platform:'opencode',agent:'build',model:'model-one',timeoutSeconds:60},caseValuesJson:JSON.stringify({__agentInsightDatasetCase:{datasetId:'dataset',caseId:'case-one'}}),results:[{evaluatorId:'quality',status:'done',score:80,humanScore:null}]}],...patch};
}
function snapshot(row:AnalysisExperimentInput,change:(v:any)=>void){const value=JSON.parse(row.configSnapshotJson!);change(value);row.configSnapshotJson=JSON.stringify(value);return row;}
test('相同固定条件按Agent版本绘图，同版本多次实验仍保留独立记录',()=>{
 const result=analyzeExperimentAssetVersions([run('one'),run('two',2),run('repeat',2)]);
 const groups=result.groups.filter(g=>g.variable==='agent');
 assert.equal(groups.length,1);assert.deepEqual(groups[0].runIds,['one','repeat','two']);
 assert.equal(result.runs.length,3);assert.equal(result.runs[0].score,80);assert.equal(result.runs[0].coverage,1);
});
test('执行模型、超时、隐藏参数、Case范围/规则和评估器配置分别隔离，不能冒充单变量',()=>{
 const base=run('base');const changed=[run('v2',2),
  snapshot(run('model',3),s=>s.executionTarget.model='other'),
  snapshot(run('timeout',4),s=>s.executionTarget.timeoutSeconds=120),
  snapshot(run('parameter',5),s=>s.executionTarget.agentOptions={apiKey:'private-one'}),
  run('case',6,{cases:[{...run('x').cases[0],referenceOutput:'changed'}]}),
  run('evaluator',7,{evaluatorConfigsJson:'{"quality":{"mode":"other"}}'})];
 const result=analyzeExperimentAssetVersions([base,...changed]);
 assert.equal(result.groups.filter(g=>g.variable==='agent').length,6);
 assert.equal(result.groups.find(g=>g.variable==='agent'&&g.runIds.includes('base'))!.runIds.length,2);
 assert.ok(!JSON.stringify(result).includes('private-one'));
});
test('失败与无分结果不计0，人工修正优先，partial展示真实评分覆盖率',()=>{
 const row=run('partial',1,{status:'partial',cases:[{input:'one',results:[{evaluatorId:'quality',status:'done',score:20,humanScore:90}]},{input:'two',results:[{evaluatorId:'quality',status:'failed',score:0,humanScore:null}]},{input:'three',results:[{evaluatorId:'quality',status:'done',score:null,humanScore:null}]}]});
 const result=analyzeExperimentAssetVersions([row,run('failed',2,{status:'failed'})]);
 assert.equal(result.runs[0].score,90);assert.equal(result.runs[0].scoredResults,1);assert.equal(result.runs[0].expectedResults,3);assert.equal(result.runs[0].coverage,1/3);
 assert.equal(result.runs[1].score,null);
});
test('旧实验未记录版本仅列出，不虚构版本趋势，冻结提示词不流出',()=>{
 const old=run('old',1,{configSnapshotJson:null});
 const current=snapshot(run('current'),s=>{s.assetVersions.agent.definition.prompt='do-not-export-prompt';s.assetVersions.evaluators.quality.definition.llmConfig={systemPrompt:'another-secret'};});
 const result=analyzeExperimentAssetVersions([old,current]);
 assert.equal(result.runs[0].comparable,false);assert.match(result.runs[0].reason!,/版本/);
 assert.ok(result.groups.every(g=>!g.runIds.includes('old')));
 assert.ok(!JSON.stringify(result).includes('do-not-export-prompt'));assert.ok(!JSON.stringify(result).includes('another-secret'));
});
test('评测集变量允许整体Case定义变化，部分Case选择和其他固定版本不能混合',()=>{
 const one=run('one');const two=snapshot(run('two'),s=>{s.assetVersions.dataset.version=2;s.assetVersions.dataset.versionId='dataset2';s.assetVersions.dataset.contentHash='dataset2';});
 two.cases[0].input='new question';
 const partial=snapshot(run('partial'),s=>s.assetVersions.dataset.definition.cases.push({id:'case-two'}));
 const result=analyzeExperimentAssetVersions([one,two,partial]);
 const group=result.groups.find(g=>g.variable==='dataset'&&g.runIds.includes('one'))!;
 assert.deepEqual(group.runIds,['one','two']);assert.match(group.warning!,/不等于 Agent/);
 assert.ok(!group.runIds.includes('partial'));
});
test('变化条件分别成组、不同评估器版本与Skill版本不能混入Agent趋势',()=>{
 const evaluator=snapshot(run('eval'),s=>s.assetVersions.evaluators.quality.version=2);
 const skill=run('skill',1,{skillVersion:2});
 const result=analyzeExperimentAssetVersions([run('base'),run('agent',2),evaluator,skill]);
 assert.equal(result.groups.find(g=>g.variable==='agent'&&g.runIds.includes('base'))!.runIds.length,2);
 assert.equal(result.groups.find(g=>g.variable==='evaluator'&&g.runIds.includes('base'))!.runIds.length,2);
 assert.equal(result.groups.find(g=>g.variable==='skill'&&g.runIds.includes('base'))!.runIds.length,2);
});
test('已有Trace必须隔离不同执行记录，缺少执行目标的生成实验不冒充固定条件',()=>{
 const first=snapshot(run('first'),s=>s.traceSource='existing');first.cases[0].executionId='trace-one';
 const same=snapshot(run('same',2),s=>s.traceSource='existing');same.cases[0].executionId='trace-one';
 const other=snapshot(run('other',3),s=>s.traceSource='existing');other.cases[0].executionId='trace-two';
 const missing=snapshot(run('missing',4),s=>delete s.executionTarget);
 const result=analyzeExperimentAssetVersions([first,same,other,missing]);
 assert.equal(result.runs[3].comparable,false);assert.match(result.runs[3].reason!,/执行/);
 const group=result.groups.find(g=>g.variable==='agent'&&g.runIds.includes('first'))!;
 assert.deepEqual(group.runIds,['first','same']);assert.ok(!JSON.stringify(result).includes('trace-one'));
});
test('冻结target相同也要隔离实际model或重试worker变化，多Case混合条件不绘制单配置曲线',()=>{
 const first=run('first'),model=run('model',2),worker=run('worker',3);
 model.cases[0].execution!.model='model-other';
 worker.cases[0].execution!.clientId='client-other';worker.cases[0].boundAttempt!.workerId='client-other';
 const mixed=run('mixed',4,{cases:[first.cases[0],worker.cases[0]]});
 const result=analyzeExperimentAssetVersions([first,model,worker,mixed]);
 assert.equal(result.groups.filter(g=>g.variable==='agent').length,3);
 assert.equal(result.runs[3].comparable,false);assert.match(result.runs[3].reason!,/实际.*不一致/);
 assert.ok(!result.groups.some(g=>g.runIds.includes('mixed')));
});
test('缺少实际模型或绑定执行证据时不把声明当执行事实',()=>{
 const absent=run('absent');absent.cases[0].execution=null;
 const model=run('unknown');model.cases[0].execution!.model=null;
 const attempt=run('attempt');attempt.cases[0].boundAttempt=null;
 const result=analyzeExperimentAssetVersions([absent,model,attempt]);
 assert.ok(result.runs.every(r=>!r.comparable));assert.equal(result.groups.length,0);
 assert.ok(result.runs.every(r=>/实际|执行/.test(r.reason!)));
});
