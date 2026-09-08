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
