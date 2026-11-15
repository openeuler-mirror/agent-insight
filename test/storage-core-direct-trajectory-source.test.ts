import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';

function fixture(){let legacy=0;const calls:Array<{action:string;payload:Record<string,unknown>}>=[];const snapshots=[{coverage:'complete',experiment:{id:'run',user:'alice',scope:'trajectory-direct',configSnapshotJson:JSON.stringify({customEvaluatorSnapshots:{schemaVersion:1,cards:{'custom-one':{id:'custom-one',name:'safe'}}},coreDirectDatasets:{datasets:[]},coreAssets:{directSelectedEvaluators:['custom-one']}}),groups:[],comments:[],cases:[{id:'case',taskId:'task',directTrajectory:{id:'case',user:'alice',evaluatorRunId:'run',taskId:'task',datasetId:'dataset',caseId:'gold',status:'pending',createdAt:'2026-01-01T00:00:00.000Z',rawAnalysisJson:'{"watchPlaceholder":false}'},results:[{id:'slot',evaluatorId:'__direct_trajectory__',status:'done',score:0,evidenceJson:'{"directTrajectory":{"id":"case","evaluatorRunId":"run","taskId":"task","datasetId":"dataset","caseId":"gold","status":"done","trajectoryScore":0,"rawAnalysisJson":"{}"}}',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-02T00:00:00.000Z'}]}]},executions:[],sessions:[]}];
 const context={actor:{username:'alice'},operationKey:'request',rpc:async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});if(action==='read_view')return {coverage:'complete',snapshots};if(action==='read')return snapshots[0];if(action==='case_upsert')return {case_id:(payload.case as Record<string,unknown>).id,reused:false};return {};}};
 const dependencies:Record<string,unknown>={'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiment-view':{createExperimentReadView:()=>({})},'node:crypto':{createHash},'@/lib/storage-core/experiment-assets':{prepareDirectTrajectoryAppend:async(_ctx:unknown,dto:unknown)=>dto}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/eval/direct-trajectory-source.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>dependencies[id]||{},Date,JSON,structuredClone});
 return {api:module.exports as Record<string,Function>,context,calls,get legacy(){return legacy;}};
}

test('direct read DTO comes from selected immutable evidence and keeps legacy zero score',async()=>{
 const f=fixture();const source=await f.api.directTrajectorySource({});const rows=await source.trajectoryEvalResult.findMany({where:{user:'alice',evaluatorRunId:'run'}});assert.equal(rows.length,1);assert.equal(rows[0].trajectoryScore,0);assert.equal(rows[0].status,'done');assert.ok(rows[0].createdAt instanceof Date);
 const groups=await source.trajectoryEvalResult.groupBy({where:{user:'alice'},by:['evaluatorRunId'],_min:{createdAt:true},orderBy:{_min:{createdAt:'desc'}},take:10});assert.equal(groups[0].evaluatorRunId,'run');
 assert.equal((await source.trajectoryEvalResult.findMany({where:{user:'other'}})).length,0);assert.equal(f.legacy,0);
});

test('direct metadata adapter rejects arbitrary machine result mutations',async()=>{
 const f=fixture();const source=await f.api.directTrajectorySource({});await assert.rejects(source.trajectoryEvalResult.update({where:{id:'case'},data:{trajectoryScore:0.5}}),error=>(error as {status:number}).status===503);
});

test('direct dimensions merge selected immutable rows while another evaluator remains pending',()=>{
 const f=fixture();assert.equal(typeof f.api.projectDirectTrajectoryCase,'function');const request={id:'case',status:'pending',rawAnalysisJson:'{"selectedEvaluators":["preset-agent-trace-quality","custom-one"],"selectedEvaluatorNames":["Trace","Custom"]}'};
 const item:{id:string;directTrajectory:Record<string,unknown>;results:Array<Record<string,unknown>>}={id:'case',directTrajectory:request,results:[{evaluatorId:'__direct_trajectory__:preset-agent-trace-quality',status:'done',evidenceJson:JSON.stringify({json:{directTrajectory:{trajectoryScore:0.8,status:'done',rawAnalysisJson:'{"selectedEvaluators":["preset-agent-trace-quality"],"reason":"trace done"}'}}})},{evaluatorId:'__direct_trajectory__:custom-one',status:'running',score:null}]};
 const projected=f.api.projectDirectTrajectoryCase({id:'run',user:'alice'},item);assert.equal(projected.status,'running');assert.equal(projected.trajectoryScore,0.8);assert.deepEqual(JSON.parse(projected.rawAnalysisJson).selectedEvaluators,['preset-agent-trace-quality','custom-one']);
 item.results[1]={evaluatorId:'__direct_trajectory__:custom-one',status:'done',score:75,evidenceJson:JSON.stringify({json:{directTrajectory:{status:'done',trajectoryScore:null,rawAnalysisJson:'{"customEvaluations":{"custom-one":{"score":75}},"customEvaluationScore":75}'}}})};
 const done=f.api.projectDirectTrajectoryCase({id:'run',user:'alice'},item);assert.equal(done.status,'done');assert.equal(done.trajectoryScore,0.8);assert.equal(JSON.parse(done.rawAnalysisJson).customEvaluationScore,75);
});

test('watch metadata updates never persist selected machine scores back into request Case',async()=>{
 const f=fixture();const source=await f.api.directTrajectorySource({});await source.trajectoryEvalResult.update({where:{id:'case'},data:{rawAnalysisJson:'{"autoWatch":true,"watchedAgent":"agent","trajectoryScore":0.9,"resultEvaluation":{"score":0.7}}'}});
 const write=f.calls.find(call=>call.action==='case_upsert')!;const stored=JSON.parse(((write.payload.case as Record<string,unknown>).directTrajectory as Record<string,unknown>).rawAnalysisJson as string);assert.equal(stored.autoWatch,true);assert.equal(stored.watchedAgent,'agent');assert.equal(stored.resultEvaluation,undefined);assert.equal(stored.trajectoryScore,undefined);
});

test('mixed result failure retains original done Trace status and result diagnostic metadata',()=>{
 const f=fixture();const request={id:'case',rawAnalysisJson:'{"selectedEvaluators":["preset-agent-trace-quality","preset-agent-task-completion"]}'};
 const result=(evaluatorId:string,status:string,directTrajectory:Record<string,unknown>)=>({evaluatorId:'__direct_trajectory__:'+evaluatorId,status,evidenceJson:JSON.stringify({json:{directTrajectory}})});
 const projected=f.api.projectDirectTrajectoryCase({id:'run',user:'alice'},{id:'case',directTrajectory:request,results:[result('preset-agent-trace-quality','done',{trajectoryScore:0.8,status:'done',rawAnalysisJson:'{}'}),result('preset-agent-task-completion','failed',{status:'failed',errorMessage:'result failed',rawAnalysisJson:'{"resultEvaluationError":"result failed"}'})]});
 assert.equal(projected.status,'done');assert.equal(projected.trajectoryScore,0.8);assert.equal(projected.errorMessage,null);assert.equal(JSON.parse(projected.rawAnalysisJson).resultEvaluationError,'result failed');
});

test('dimension merge never overwrites valid task result with null from another evaluator',()=>{
 const f=fixture();const evidence=(rawAnalysisJson:string)=>JSON.stringify({json:{directTrajectory:{status:'done',rawAnalysisJson}}});
 const projected=f.api.projectDirectTrajectoryCase({id:'run',user:'alice'},{id:'case',directTrajectory:{rawAnalysisJson:'{"selectedEvaluators":["preset-agent-task-completion","preset-agent-trace-quality","custom-one"]}'},results:[{evaluatorId:'__direct_trajectory__:preset-agent-task-completion',status:'done',evidenceJson:evidence('{"resultEvaluation":{"score":0.6},"resultActualOutput":"real output"}')},{evaluatorId:'__direct_trajectory__:preset-agent-trace-quality',status:'done',evidenceJson:evidence('{"resultEvaluation":null,"customEvaluations":null}')},{evaluatorId:'__direct_trajectory__:custom-one',status:'done',evidenceJson:evidence('{"resultEvaluation":null,"customEvaluations":{"custom-one":{"score":75}}}')}]});
 assert.equal(JSON.parse(projected.rawAnalysisJson).resultEvaluation.score,0.6);assert.equal(JSON.parse(projected.rawAnalysisJson).resultActualOutput,'real output');assert.equal(JSON.parse(projected.rawAnalysisJson).customEvaluationScore,75);
});


test('explicit re-evaluation preserves older compatibility result IDs and sanitizes stored custom snapshots',async()=>{
 const f=fixture();const data={user:'alice',evaluatorRunId:'run',taskId:'task',status:'pending',rawAnalysisJson:JSON.stringify({selectedEvaluators:['custom-one'],customEvaluatorSnapshots:{cards:{'custom-one':{apiKey:'injected-secret'}}}})};
 const first=await (await f.api.directTrajectorySource({})).trajectoryEvalResult.create({data});assert.notEqual(first.id,'case');
 f.context.operationKey='new-request';const next=await (await f.api.directTrajectorySource({})).trajectoryEvalResult.create({data});assert.notEqual(next.id,first.id);
 const writes=f.calls.filter(call=>call.action==='case_upsert');assert.equal((writes[0].payload.case as Record<string,unknown>).groupId,first.id);assert.ok(!JSON.stringify(writes).includes('injected-secret'));
});
