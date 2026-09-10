import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDemoVersionView,expandVersionRuns} from '../../src/lib/evaluation-harness/demo-versions';
const asset=(kind:string,version:number)=>({id:kind+version,assetKey:kind,name:kind,version,content:{type:kind},contentHash:kind+version});
const run=(id:string,score:number|null,agent=1,skill=1,evaluator=1,dataset=1,model='m'):any=>({id,name:id,status:'done',createdAt:id,summary:{score},manifest:{target:asset('agent',agent),skill:asset('skill',skill),dataset:asset('dataset',dataset),evaluators:[asset('evaluator',evaluator)],evaluatorIds:['evaluator'+evaluator],execution:{endpoint:'http://localhost',model},threshold:90,caseIds:['one'],groups:[]}});
const choices:any={agent:{assetKey:'agent',id:'agent1',vary:true},skill:{assetKey:'skill',id:'skill1',vary:false},evaluator:{assetKey:'evaluator',id:'evaluator1',vary:false},dataset:{assetKey:'dataset',id:'dataset1',vary:false}};
test('four selectors filter fixed versions and permit only checked dimensions to vary',()=>{
 const input=[run('01',0),run('02',100,2),run('03',100,2,2),run('04',100,2,1,2),run('05',100,2,1,1,2)];
 assert.equal(buildDemoVersionView(input,choices).rows.length,2);
 for(const kind of ['skill','evaluator','dataset']){
  const view=buildDemoVersionView(input,{...choices,[kind]:{...choices[kind],vary:true}});assert.equal(view.rows.length,3);
 }
 assert.equal(buildDemoVersionView(input,Object.fromEntries(Object.entries(choices).map(([k,v]:any)=>[k,{...v,vary:true}])) as any).rows.length,5);
});
test('A/B records use each group score, preserve all four versions, and never reuse overall score when a group score is missing',()=>{
 const r=run('01',50);r.manifest.comparison={dimension:'agent'};r.manifest.groups=[{key:'A',id:'A',target:asset('agent',1),skill:asset('skill',1),dataset:asset('dataset',1),evaluatorIds:['evaluator1']},{key:'B',id:'B',target:asset('agent',2),skill:asset('skill',1),dataset:asset('dataset',1),evaluatorIds:['evaluator1']}];r.groupSummaries=[{key:'A',summary:{score:0}},{key:'B',summary:{score:100}}];
 assert.deepEqual(expandVersionRuns([r]).map(row=>row.score),[0,100]);r.groupSummaries.pop();assert.equal(expandVersionRuns([r])[1].score,null);
});
test('trend uses latest scored run for each combination and keeps execution conditions separate without converting missing scores to zero',()=>{
 const rows=[run('01',20),run('02',70),run('03',null,2),run('04',100,2,1,1,1,'other')];
 const result=buildDemoVersionView(rows,choices);assert.equal(result.rows.length,4);assert.equal(result.series.length,2);assert.deepEqual(result.series.map(s=>s.points.map(p=>p.score)),[[70],[100]]);
});

test('default-model execution compares the effective Agent model rather than the empty override',()=>{
 const a=run('01',50),b=run('02',100,2);a.manifest.execution.model='';b.manifest.execution.model='';a.manifest.target.content.model='model-a';b.manifest.target.content.model='model-b';
 const view=buildDemoVersionView([a,b],choices);assert.equal(view.series.length,2);assert.deepEqual(view.series.map(s=>s.label),['model-a','model-b']);
});

test('legacy Skill-as-target experiments do not populate Agent version analysis',()=>{
 const legacy=run('legacy',100);legacy.manifest.target=asset('skill',1);
 assert.equal(expandVersionRuns([legacy]).length,0);
});

test('implicit and explicit whole-dataset selections share one chart and show actual saved settings',()=>{
 const a=run('01',50),b=run('02',100,2);
 for(const row of [a,b]){row.manifest.dataset.content.cases=[{id:'one',name:'低风险申请'},{id:'two',name:'高风险复核'}];row.manifest.concurrency=2;row.manifest.timeoutSeconds=60;row.manifest.retries=0;}
 delete a.manifest.caseIds;b.manifest.caseIds=['two','one'];
 const view=buildDemoVersionView([a,b],choices);
 assert.equal(view.series.length,1);
 const fields=Object.fromEntries(view.series[0].configuration.map(item=>[item.label,item.value]));
 assert.equal(fields['Case 范围'],'全部 Case（2 条）');
 assert.equal(fields['执行地址'],'http://localhost/');
 assert.equal(fields['并发数'],'2');assert.equal(fields['超时'],'60 秒');assert.equal(fields['失败重试'],'0 次');
 assert.equal(view.series[0].records.length,2);
});

test('same-size Case subsets display their names and Trace assignments determine the actual subset',()=>{
 const a=run('01',50),b=run('02',100,2);
 for(const row of [a,b])row.manifest.dataset.content.cases=[{id:'one',name:'低风险申请'},{id:'two',name:'高风险复核'}];
 a.manifest.traceSource='existing';a.manifest.traceAssignments=[{traceId:'trace1',caseId:'two'}];
 b.manifest.traceSource='existing';b.manifest.caseIds=['one'];
 const view=buildDemoVersionView([a,b],choices);assert.equal(view.series.length,2);
 assert.match(view.series[0].configuration.find(item=>item.label==='Case 范围')!.details!,/高风险复核/);
 assert.match(view.series[1].configuration.find(item=>item.label==='Case 范围')!.details!,/低风险申请/);
});

test('configuration summaries preserve missing values and redact endpoint credentials and queries',()=>{
 const a=run('01',50);a.manifest.execution.endpoint='https://user:private@example.test/run?token=secret';a.manifest.threshold=0;
 const view=buildDemoVersionView([a],choices),fields=Object.fromEntries(view.series[0].configuration.map(item=>[item.label,item.value]));
 assert.equal(fields['执行地址'],'https://example.test/run');assert.equal(fields['并发数'],'未记录');assert.equal(fields['通过门槛'],'≥ 0%');
 assert(!JSON.stringify(view.series[0].configuration).includes('secret'));
});

test('fixed additional evaluators and different scoring connections explain otherwise identical charts',()=>{
 const a=run('01',50),b=run('02',100,2);
 for(const row of [a,b]){row.manifest.evaluators.push({...asset('extra',1),name:'工具参数检查'});row.manifest.evaluatorIds.push('extra1');row.manifest.modelRefs=[{evaluatorId:'evaluator1',model:'judge-model',keyType:'private',connectionHash:row.id}];}
 const view=buildDemoVersionView([a,b],choices);assert.equal(view.series.length,2);
 const configs=view.series.map(series=>Object.fromEntries(series.configuration.map(item=>[item.label,item.value])));
 assert.equal(configs[0]['附加评估器'],'工具参数检查 v1');
 assert.notEqual(configs[0]['评分模型'],configs[1]['评分模型']);assert.match(configs[0]['评分模型'],/judge-model.*私有连接/);
 const varying=buildDemoVersionView([a,b],{...choices,evaluator:{...choices.evaluator,vary:true}});
 assert.equal(varying.series.length,1);assert.match(varying.series[0].configuration.find(item=>item.label==='评分模型')!.value,/随评估器版本变化/);
});

test('older and unscored records retain a mapping to the chart with the same configuration',()=>{
 const view=buildDemoVersionView([run('01',50),run('02',100),run('03',null,2)],choices);
 assert.equal(view.series[0].points.length,1);assert.equal(view.series[0].records.length,3);
});

test('different hidden endpoint parameters remain distinguishable without disclosing their values',()=>{
 const a=run('01',50),b=run('02',100,2);
 a.manifest.execution.endpoint='https://example.test/run?token=private-a';b.manifest.execution.endpoint='https://example.test/run?token=private-b';
 const view=buildDemoVersionView([a,b],choices);
 const addresses=view.series.map(series=>series.configuration.find(field=>field.label==='执行地址')!.value);
 assert.equal(new Set(addresses).size,2);assert(addresses.every(address=>address.includes('地址配置')));
 assert(!JSON.stringify(view.series.map(series=>series.configuration)).includes('private-'));
});
