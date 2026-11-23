import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prisma} from './helpers/historical-prisma';
import {runWithCoreExperimentContext,type CoreExperimentContext} from '@/lib/storage-core/experiments';
import {LLM_DIMENSION} from '@/lib/engine/experiment/variable-dimension';
import {autoPairGroups} from '@/lib/engine/experiment/comparison-runner';
import {cloneExperimentFromFrozenConfig} from '@/lib/engine/experiment/reuse-config';
const actor={username:'core-comparison-owner',principal:'owner',workspace:'w',token:'api_'+'A'.repeat(43)};
const groups=[{id:'ga',key:'A',variableValue:'m1'},{id:'gb',key:'B',variableValue:'m2'}];
const frozen={schemaVersion:1,evaluators:{custom:{card:{id:'custom',name:'原定义',source:'custom'},release_id:'frozen-release',origin:'user'}},releases:{'evaluator:custom':'frozen-release'}};
const head={id:'cmp',user:actor.username,name:'原对比',type:'llm',agentName:'agent',scope:'',status:'draft',groups,cases:[],evaluatorIdsJson:'["custom"]',evaluatorConfigsJson:'{}',configSnapshotJson:JSON.stringify({coreAssets:frozen,customEvaluatorSnapshots:{schemaVersion:1,cards:{custom:{id:'custom',name:'原定义',source:'custom'}}}})};
function context(rpc:CoreExperimentContext['rpc'],list?:unknown[]):CoreExperimentContext{
 return {actor,request:new Request('http://localhost/api/experiments',{headers:{authorization:'Bearer '+actor.token}}),operationKey:'comparison-op',body:{},rpc:(action,payload)=>action==='lookup_operation'?Promise.resolve({found:false}):rpc(action,payload),options:{fetcher:async(url)=>{
  const path=new URL(String(url)).pathname;
  if(path==='/v1/compat/platform-control')return Response.json({value:{rows:[],scope_revision:'0'}});
  if(path==='/v1/auth/me')return Response.json({principal_id:actor.principal,username:actor.username,workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  assert.equal(path,'/v1/compat/observe/data');const query=new URL(String(url)).searchParams;assert.equal(query.get('workspace_id'),'w');assert.equal(query.get('includeSubagents'),'true');assert.equal(query.get('agentName'),'agent');assert.equal(query.get('filters'),JSON.stringify([{column:'model',operator:'=',value:query.get('filters')?.includes('m1')?'m1':'m2'}]));
  return Response.json({value:(list||[]).filter(row=>(row as {model:string}).model===(query.get('filters')?.includes('m1')?'m1':'m2'))});
 }}};
}
const rows=[{upload_id:'ea',task_id:'ta',query:'同题',model:'m1',agentName:'agent',skills:['s'],invoked_skills:[{name:'s',version:2}],timestamp:'2026-11-14T00:00:00Z'},{upload_id:'eb',task_id:'tb',query:'同题',model:'m2',agentName:'agent',skills:['s'],invoked_skills:[{name:'s',version:2}],timestamp:'2026-11-14T00:00:01Z'}];
async function core<T>(ctx:CoreExperimentContext,fn:()=>Promise<T>){const old=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';try{return await runWithCoreExperimentContext(ctx,fn);}finally{if(old===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=old;}}
test.after(async()=>{await prisma.$disconnect();database.dispose();});
test('LLM comparison candidates come from authorized core Trace records, retaining Skill controls and dates',async()=>{
 const before=await prisma.execution.count();const ctx=context(async()=>{throw Error('unexpected domain action');},rows);
 const found=await core(ctx,()=>LLM_DIMENSION.queryCandidateTraces('agent','m1'));assert.equal(found.length,1);assert.deepEqual(found[0],{id:'ea',taskId:'ta',query:'同题',model:'m1',agentName:'agent',skill:'s',skillVersion:2,timestamp:new Date(rows[0].timestamp)});assert.equal(await prisma.execution.count(),before);
});
test('comparison computes original pairs and atomically submits both sides without legacy Case writes',async()=>{
 const calls:Array<{action:string;body:Record<string,unknown>}> =[];const before=await prisma.experimentCase.count();
 const ctx=context(async(action,body={})=>{calls.push({action,body});if(action==='read')return {experiment:head,revision:'7'};if(action==='case_upsert_many')return {case_ids:['ca','cb'],experiment:{...head,cases:[]}};throw Error('unexpected '+action);},rows);
 const pairs=await core(ctx,()=>autoPairGroups('cmp'));assert.equal(pairs.length,1);assert.equal(pairs[0].status,'可比');const batch=calls.find(call=>call.action==='case_upsert_many');assert.ok(batch);assert.equal(batch.body.expected_revision,'7');assert.deepEqual((batch.body.cases as Array<Record<string,unknown>>).map(row=>[row.groupId,row.executionId,row.taskId,row.input]),[['ga','ea','ta','同题'],['gb','eb','tb','同题']]);assert.equal(await prisma.experimentCase.count(),before);
});
test('committed atomic pairing retry checks its exact receipt before reading changed candidate catalogs',async()=>{
 const ctx=context(async()=>{throw Error('latest source must not be read');});ctx.rpc=async(action,payload)=>{assert.equal(action,'lookup_operation');assert.equal(payload?.operation_kind,'case_upsert_many');assert.equal(payload?.operation_key,'comparison-op:pair');assert.deepEqual(payload?.operation_request,{experiment_id:'cmp',request:{method:'GET',path:'/api/experiments',ifMatch:null,body:{}}});return {found:true,result:{case_ids:['ca','cb']}};};
 assert.deepEqual(await core(ctx,()=>autoPairGroups('cmp')),[]);
});
test('same-config core clone retains original frozen releases even when no latest evaluator exists',async()=>{
 let created:Record<string,unknown>|undefined;const before=await prisma.experiment.count();const source={...head,type:'single',groups:[],cases:[{id:'old-case',input:'问题',taskId:null,executionId:null,referenceOutput:'答案',actualOutput:'结果',results:[{score:90}]}]};
 const ctx=context(async(action,body={})=>{if(action==='read')return {experiment:source,revision:'3'};if(action==='create'){created=body.experiment as Record<string,unknown>;return {experiment:{...created,id:'cloned'}};}throw Error('unexpected latest lookup '+action);});
 const result=await core(ctx,()=>cloneExperimentFromFrozenConfig({sourceExperimentId:'cmp',user:actor.username}));assert.equal(result.id,'cloned');assert.ok(created);const snapshot=JSON.parse(String(created.configSnapshotJson));assert.deepEqual(snapshot.coreAssets,frozen);assert.equal(created.sourceExperimentId,'cmp');assert.equal((created.cases as Array<Record<string,unknown>>)[0].referenceOutput,'答案');assert.notEqual((created.cases as Array<Record<string,unknown>>)[0].id,'old-case');assert.ok(!JSON.stringify(created).includes('"score":90'));assert.equal(await prisma.experiment.count(),before);
});

test('core comparison creation freezes evaluators and assigns persistent group identities',async()=>{
 const {createComparisonExperiment}=await import('@/lib/engine/experiment/comparison-runner');let created:Record<string,unknown>|undefined;
 const ctx=context(async(action,body={})=>{assert.equal(action,'create');created=body.experiment as Record<string,unknown>;return {experiment:{...created,id:'created-comparison'}};});
 ctx.options.fetcher=async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/compat/platform-control')return Response.json({value:{rows:[],scope_revision:'0'}});
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:actor.principal,username:actor.username,workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  assert.equal(new URL(String(url)).pathname,'/v1/compat/evaluators');assert.equal(JSON.parse(String(options?.body)).action,'freeze');return Response.json({value:{schemaVersion:1,cards:{},releases:[],list_etag:'"empty"'}});
 };
 const before=await prisma.experiment.count();const result=await core(ctx,()=>createComparisonExperiment({user:actor.username,name:'创建对比',agentName:'agent',variableDimension:'llm',groups:[{key:'A',value:'m1'},{key:'B',value:'m2'}],evaluatorIds:['preset-agent-trace-quality']}));
 assert.equal(result.id,'created-comparison');assert.equal(created?.type,'llm');const saved=created!.groups as Array<{id:string;key:string;variableValue:string}>;assert.equal(new Set(saved.map(group=>group.id)).size,2);assert.deepEqual(saved.map(group=>[group.key,group.variableValue]),[['A','m1'],['B','m2']]);assert.equal(JSON.parse(String(created!.configSnapshotJson)).coreAssets.evaluators['preset-agent-trace-quality'].origin,'builtin');assert.equal(await prisma.experiment.count(),before);
});

test('core comparison starts the existing frozen RunPlan once and never inserts legacy score slots',async()=>{
 const {startComparisonRun}=await import('@/lib/engine/experiment/comparison-runner');const calls:string[]=[];let status='draft';
 const ctx=context(async(action,body={})=>{
  calls.push(action);if(action==='read')return {experiment:{...head,status},revision:'7'};
  if(action==='start'){assert.deepEqual(body.frozen_evaluators,frozen.evaluators);assert.deepEqual(body.releases,frozen.releases);status='running';return {run_id:'run'};}
  if(action==='claim')return null;if(action==='reconcile')return {experiment:{...head,status:'done'}};throw Error('unexpected '+action);
 });
 const before=await prisma.experimentEvalResult.count();await core(ctx,async()=>{const started=await startComparisonRun('cmp',actor.username);assert.equal(started?.status,'running');await started?.completion;assert.deepEqual(await startComparisonRun('cmp',actor.username),{status:'running',alreadyRunning:true});});assert.equal(calls.filter(action=>action==='start').length,1);assert.equal(await prisma.experimentEvalResult.count(),before);
});

test('core rescan preserves downgrade counts and evaluates only newly paired cases',async()=>{
 const {rescanComparison}=await import('@/lib/engine/experiment/comparison-runner');const calls:Array<{action:string;body:Record<string,unknown>}> =[];
 const ctx=context(async(action,body={})=>{calls.push({action,body});if(action==='read')return {experiment:head,revision:'7'};if(action==='case_upsert_many')return {case_ids:['new-a','new-b']};if(action==='start')return {run_id:'run'};if(action==='claim')return null;if(action==='reconcile')return {};throw Error('unexpected '+action);},rows);
 const result=await core(ctx,()=>rescanComparison('cmp',actor.username));assert.deepEqual(result,{newPairsCount:1,downgradedPairs:0});assert.deepEqual(calls.find(call=>call.action==='start')?.body.case_ids,['new-a','new-b']);
});

test('core clone refuses missing private freezes and task domains without falling back to legacy tables',async()=>{
 const before=await prisma.experiment.count();
 for(const source of [{...head,configSnapshotJson:'{}'},{...head,scope:'benchmark'}]){
  const ctx=context(async(action)=>{assert.equal(action,'read');return {experiment:source};});
  await assert.rejects(()=>core(ctx,()=>cloneExperimentFromFrozenConfig({sourceExperimentId:'cmp',user:actor.username})),error=>[409,503].includes((error as {status:number}).status));
 }
 assert.equal(await prisma.experiment.count(),before);
});

test('comparison detail retains the original complete DTO, scores, metric units and fallback output after legacy rows are removed',async()=>{
 const {getComparisonDetail}=await import('@/lib/engine/experiment/comparison-runner');const {createExperimentReadView}=await import('@/lib/storage-core/experiment-view');
 const agent='comparison-detail-golden';const executions:import('@prisma/client').Execution[]=[];
 for(const [index,model] of ['m1','m2'].entries())executions.push(await prisma.execution.create({data:{user:actor.username,taskId:'golden-task-'+index,agentName:agent,model,query:'同题',skill:'s',skillVersion:2,cost:index+1,latency:(index+1)*100,toolCallCount:index+2,isAnswerCorrect:index===0,finalResult:'输出'+index}}));
 const created=await prisma.experiment.create({data:{user:actor.username,name:'完整DTO对比',agentName:agent,type:'llm',status:'done',evaluatorIdsJson:'["preset-agent-trace-quality"]',groups:{create:[{key:'A',variableValue:'m1'},{key:'B',variableValue:'m2'}]}},include:{groups:{orderBy:{key:'asc'}}}});
 for(const [index,execution] of executions.entries()){
  const item=await prisma.experimentCase.create({data:{experimentId:created.id,groupId:created.groups[index].id,executionId:execution.id,taskId:execution.taskId,input:'同题'}});
  await prisma.experimentEvalResult.create({data:{experimentId:created.id,caseId:item.id,evaluatorId:'preset-agent-trace-quality',status:'done',score:index===0?80:60}});
 }
 const source=await prisma.experiment.findUniqueOrThrow({where:{id:created.id},include:{groups:{orderBy:{key:'asc'}},cases:{include:{results:true,traceAttempts:true}},comments:true}});await prisma.experiment.delete({where:{id:created.id}});await prisma.execution.deleteMany({where:{id:{in:executions.map(row=>row.id)}}});
 const ctx=context(async(action)=>{assert.equal(action,'read');return {experiment:source,revision:'1'};});ctx.readView=createExperimentReadView([{coverage:'complete',experiment:JSON.parse(JSON.stringify(source)),executions:[],sessions:[],cancellations:[]}],{actorUsername:actor.username});
 ctx.options.fetcher=async(url)=>{const parsed=new URL(String(url));if(parsed.pathname==='/v1/auth/me')return Response.json({principal_id:actor.principal,username:actor.username,workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  if(parsed.pathname==='/v1/compat/observe/data'){const filter=JSON.parse(parsed.searchParams.get('filters')!)[0];return Response.json({value:executions.filter(row=>filter.column==='id'?filter.value.includes(row.id):row.model===filter.value).map(row=>({upload_id:row.id,task_id:row.taskId,query:row.query,model:row.model,agentName:row.agentName,skills:['s'],invoked_skills:[{name:'s',version:2}],timestamp:row.timestamp.toISOString(),cost:row.cost,latency:row.latency,tool_call_count:row.toolCallCount,is_answer_correct:row.isAnswerCorrect,final_result:row.finalResult}))});}
  assert.equal(parsed.pathname,'/v1/compat/observe/evidence');const execution=executions.find(row=>row.id===parsed.searchParams.get('executionId'))!;assert.ok(execution);return Response.json({value:{format:'agent-insight.trace-evidence',version:1,captured_at:'2026-11-14T00:00:00Z',snapshot_hash:'a'.repeat(64),manifest:{workspace_id:'w',trace_id:execution.id},execution,session:{taskId:execution.taskId,interactions:[]}}});
 };
 const actual=await core(ctx,()=>getComparisonDetail(created.id,{casePage:1,casePageSize:8}));assert.equal(actual.name,'完整DTO对比');assert.equal(actual.status,'done');assert.equal(actual.caseTotal,2);assert.equal(actual.casePage,1);assert.equal(actual.casePageSize,8);assert.equal(actual.createdAt.toISOString(),source.createdAt.toISOString());
 assert.deepEqual(actual.progress,{total:2,done:2,failed:0,pending:0});
 assert.deepEqual(actual.groups.map(row=>({key:row.key,overall:row.overall,avgCost:row.avgCost,avgLatency:row.avgLatency,avgSteps:row.avgSteps,successRate:row.successRate})),[{key:'A',overall:80,avgCost:1,avgLatency:100,avgSteps:2,successRate:1},{key:'B',overall:60,avgCost:2,avgLatency:200,avgSteps:3,successRate:0}]);
 assert.equal(actual.pairing.comparableCount,1);assert.equal(actual.pairing.items[0].a?.actualOutput,'输出0');assert.equal(actual.pairing.items[0].b?.actualOutput,'输出1');assert.equal(actual.pairing.items[0].a?.scores.overall,80);assert.equal(actual.pairing.items[0].b?.scores.overall,60);
 assert.equal(await prisma.experiment.count({where:{id:created.id}}),0);assert.equal(await prisma.execution.count({where:{id:{in:executions.map(row=>row.id)}}}),0);
});

test('comparison metrics use bounded summaries while stored answers avoid whole Trace reads',async()=>{
 const {readCoreComparisonExecutions}=await import('@/lib/storage-core/comparison-traces');const ctx=context(async()=>{throw Error('no domain mutation');});let requests=0;
 ctx.options.fetcher=async(url)=>{const parsed=new URL(String(url));assert.equal(parsed.pathname,'/v1/compat/observe/data');const filter=JSON.parse(parsed.searchParams.get('filters')!);assert.deepEqual(filter,[{column:'id',operator:'any of',value:['large-trace']}]);requests++;return Response.json({value:[{upload_id:'large-trace',cost:0.25,latency:2500,tool_call_count:12000,is_answer_correct:false,final_result:'已保存答案'}]});};
 const found=await core(ctx,()=>readCoreComparisonExecutions(['large-trace']));assert.deepEqual(found.get('large-trace'),{id:'large-trace',cost:0.25,latency:2500,toolCallCount:12000,isAnswerCorrect:false,finalResult:'已保存答案'});assert.equal(requests,1);
});

test('comparison summary refuses another execution outside the requested IAM-bound selection',async()=>{
 const {readCoreComparisonExecutions}=await import('@/lib/storage-core/comparison-traces');const ctx=context(async()=>{throw Error('no mutation');});ctx.options.fetcher=async()=>Response.json({value:[{upload_id:'private-other-owner',cost:1}]});
 await assert.rejects(()=>core(ctx,()=>readCoreComparisonExecutions(['allowed-id'])),error=>(error as {status:number}).status===503);
});


test('core comparison preserves its configured worker concurrency',async()=>{
 const {startComparisonRun,comparisonEngineConfig}=await import('@/lib/engine/experiment/comparison-runner');let claims=0;
 const ctx=context(async(action)=>{if(action==='read')return {experiment:head,revision:'7'};if(action==='start')return {run_id:'run'};if(action==='claim'){claims++;return null;}if(action==='reconcile')return {};throw Error('unexpected '+action);});
 const previous=comparisonEngineConfig.concurrency;comparisonEngineConfig.concurrency=2;
 try{await core(ctx,async()=>{const result=await startComparisonRun('cmp',actor.username);await result?.completion;});assert.equal(claims,2);}finally{comparisonEngineConfig.concurrency=previous;}
});

test('re-pairing an existing core Case preserves its references and annotations',async()=>{
 let saved:Array<Record<string,unknown>>=[];const existing={id:'existing-a',groupId:'ga',taskId:'ta',executionId:'ea',input:'同题',actualOutput:'保留输出',referenceOutput:'保留参考',datasetInput:'数据集问题',caseValuesJson:'{"owner":"kept"}'};
 const ctx=context(async(action,body={})=>{if(action==='read')return {experiment:{...head,cases:[existing]},revision:'7'};if(action==='case_upsert_many'){saved=body.cases as Array<Record<string,unknown>>;return {case_ids:saved.map(row=>row.id)};}throw Error('unexpected '+action);},rows);
 await core(ctx,()=>autoPairGroups('cmp'));const preserved=saved.find(row=>row.groupId==='ga')!;assert.equal(preserved.id,'existing-a');assert.equal(preserved.referenceOutput,'保留参考');assert.equal(preserved.actualOutput,'保留输出');assert.equal(preserved.datasetInput,'数据集问题');assert.equal(preserved.caseValuesJson,'{"owner":"kept"}');
});

test('metadata-only group visibility cannot overwrite another owner private comparison inputs',async()=>{
 const ctx=context(async(action)=>{assert.equal(action,'read');return {experiment:head,revision:'7',gold_redacted:true};},rows);
 await assert.rejects(()=>core(ctx,()=>autoPairGroups('cmp')),error=>(error as {status:number}).status===403);
});

test('rescan skips deleted pair tombstones and still evaluates newly discovered pairs',async()=>{
 const {rescanComparison}=await import('@/lib/engine/experiment/comparison-runner');const candidates=[...rows.map(row=>({...row,query:'deleted pair'})),...rows.map(row=>({...row,upload_id:'new-'+row.upload_id,task_id:'new-'+row.task_id,query:'new pair'}))];let writtenIds:string[]=[];let startedIds:unknown;
 const ctx=context(async(action,body={})=>{if(action==='read')return {experiment:head,revision:'7'};if(action==='case_upsert_many'){assert.equal(body.skip_deleted,true);const cases=body.cases as Array<Record<string,unknown>>;writtenIds=cases.filter(row=>row.input==='new pair').map(row=>String(row.id));return {case_ids:writtenIds,skipped_deleted_ids:cases.filter(row=>row.input==='deleted pair').map(row=>row.id)};}if(action==='start'){startedIds=body.case_ids;return {run_id:'run'};}if(action==='claim')return null;if(action==='reconcile')return {};throw Error('unexpected '+action);},candidates);
 const result=await core(ctx,()=>rescanComparison('cmp',actor.username));assert.deepEqual(result,{newPairsCount:1,downgradedPairs:0});assert.deepEqual(startedIds,writtenIds);assert.equal(writtenIds.length,2);
});
