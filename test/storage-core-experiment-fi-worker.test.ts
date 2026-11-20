import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as delivery from '../src/lib/storage-core/execution-delivery';
import * as crypto from 'node:crypto';
import {startIsolatedControlCore} from './helpers/isolated-control-core';
import * as fi from '@/lib/storage-core/fault-injection';
let core: Awaited<ReturnType<typeof startIsolatedControlCore>>;
test.before(async()=>{core=await startIsolatedControlCore(['core-owner']);});
test.after(async()=>{await core?.dispose();});
function loadStore(catalog:()=>Promise<unknown>){
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/fault-injection/store.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>({crypto,'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>false},'@/lib/storage/prisma':{prisma:new Proxy({},{get(){throw Error('Retired FI storage accessed');}})},'@/lib/storage-core/fault-injection':fi,'@/lib/fault-injection/engine':{listFaultsViaPython:catalog},'@/lib/fault-injection/compose-prompt':{composeFaultPrompt:({basePrompt}:{basePrompt:string})=>basePrompt,findSubmode:()=>null}}[id]??{}),console});return module.exports as {createTaskWithRuns:Function};
}
const input={user:'core-owner',platform:'opencode',agent:'build',prompt:'public task',workspace:'sandbox',model:'model',items:[{fault:'network',submode:null}]};
const stable={taskKey:'task-01234567',runIds:['ras-20261114T010101-01234567']};
test('stable FI creation validates its catalog before atomically publishing runnable work',async()=>core.run('core-owner',async()=>{
 const api=loadStore(async()=>{throw Error('catalog unavailable');});
 const before=(await fi.listCoreFiTasks()).length;await assert.rejects(api.createTaskWithRuns(input,stable),/catalog unavailable/);assert.equal((await fi.listCoreFiTasks()).length,before);
}));
test('stable FI retry reuses original actor and immutable execution input',async()=>core.run('core-owner',async()=>{
 const api=loadStore(async()=>[]);const first=await api.createTaskWithRuns(input,stable);const second=await api.createTaskWithRuns(input,stable);
 assert.equal(first.task.id,second.task.id);assert.equal(first.runs[0].runId,stable.runIds[0]);assert.equal((await fi.listCoreFiTasks({includeRuns:true})).flatMap(task=>task.runs).length,1);
 await assert.rejects(api.createTaskWithRuns({...input,user:'other'},stable),(error:unknown)=>(error as {status:number}).status===403);
 await assert.rejects(api.createTaskWithRuns({...input,prompt:'different input'},stable),(error:unknown)=>(error as {status:number}).status===409);
}));

test('core FI execution binds a fenced identity before publishing its physical fault task',async()=>{
 const calls:Array<{action:string;payload:Record<string,unknown>}>=[];
 const handle={experiment_id:'exp',run_id:'run',attempt_id:'attempt',case_id:'case',fence:'2',checkpoint_revision:'1',lease_owner:'worker'};
 const request={kind:'fi',experimentId:'exp',platform:'opencode',agent:'build',cases:[{caseId:'case',fault:'network'}]};
 const context={actor:{username:'alice'},rpc:async(action:string,payload:Record<string,unknown>)=>{calls.push({action,payload});if(action==='load_work')return {execution_request:request,raw_case:{id:'case',input:'public',referenceOutput:'secret gold'},checkpoint:{}};return handle;}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/experiment-fi-worker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>id==='./execution-delivery'?delivery:({
  '@/lib/fault-injection/store':{newTaskKey:()=> 'task-stable',newRunId:()=> 'ras-stable'},
  '@/lib/engine/experiment/fi-orchestrate':{createFiCaseTask:async(...args:unknown[])=>{calls.push({action:'create',payload:{args}});return {task:{id:'task'},runs:[{runId:'ras-stable'}]};},findFiRunByKey:async()=>({runId:'ras-stable',status:'completed',sessionTaskId:'session',user:'alice'}),cancelFiExecution:async()=>{},isCoreFiBusinessTraceReady:async()=>true},
 }[id]??{}),console,setTimeout,clearTimeout,setInterval,clearInterval,AbortController});
 const result=await (module.exports as {runCoreFiWork:Function}).runCoreFiWork(handle,context);
 assert.equal(result.ready,true);const checkpoint=calls.findIndex(c=>c.action==='checkpoint');const created=calls.findIndex(c=>c.action==='create');assert.ok(checkpoint>=0&&checkpoint<created);assert.ok(!JSON.stringify(calls[created]).includes('secret gold'));assert.ok(calls.some(c=>c.action==='execute_complete'));
});

for(const committed of [true,false])test(`FI completion transport loss ${committed?'confirms its own receipt':'stays indeterminate'} without a new fault task or compensating fail`,async()=>{
 let created=0,stopped=0,failed=0;let submitted:Record<string,unknown>|undefined;
 const handle={experiment_id:'exp',run_id:'run',attempt_id:'attempt',case_id:'case',fence:'2',checkpoint_revision:'1',lease_owner:'worker'};
 const request={kind:'fi',experimentId:'exp',platform:'opencode',agent:'build',cases:[{caseId:'case',fault:'network'}]};
 const context={actor:{username:'alice'},rpc:async(action:string,payload:Record<string,unknown>)=>{
  if(action==='load_work')return {execution_request:request,raw_case:{id:'case',input:'public'},checkpoint:{}};
  if(action==='execute_complete'){submitted=payload;throw new TypeError('lost response');}
  if(action==='lookup_operation'){assert.equal(payload.operation_kind,'execute_complete');assert.equal(payload.operation_key,submitted?.operation_key);assert.deepEqual(payload.operation_request,submitted?.operation_request);return committed?{found:true,result:{execution_run_id:'run'}}:{found:false};}
  if(action==='execute_fail')failed++;return handle;
 }};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/experiment-fi-worker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>id==='./execution-delivery'?delivery:({
  '@/lib/fault-injection/store':{newTaskKey:()=> 'task-stable',newRunId:()=> 'ras-stable'},
  '@/lib/engine/experiment/fi-orchestrate':{createFiCaseTask:async()=>{created++;return {task:{id:'task'},runs:[{runId:'ras-stable'}]};},findFiRunByKey:async()=>({runId:'ras-stable',status:'completed',sessionTaskId:'session',user:'alice'}),cancelFiExecution:async()=>{stopped++;},isCoreFiBusinessTraceReady:async()=>true},
 }[id]??{}),console,setTimeout,clearTimeout,setInterval,clearInterval,AbortController});
 const execute=()=> (module.exports as {runCoreFiWork:Function}).runCoreFiWork(handle,context);
 if(committed)assert.equal((await execute()).ready,true);else await assert.rejects(execute(),error=>delivery.isCoreDeliveryUncertain(error));
 assert.equal(created,1);assert.equal(stopped,0);assert.equal(failed,0);
});

test('a conflicting FI Run rolls back the entire newly queued group',async()=>core.run('core-owner',async()=>{
 const api=loadStore(async()=>[]);const tasks=(await fi.listCoreFiTasks()).length;const runs=(await fi.listCoreFiTasks({includeRuns:true})).flatMap(task=>task.runs).length;
 await assert.rejects(api.createTaskWithRuns({...input,items:[{fault:'network'},{fault:'network'}]},{taskKey:'task-89abcdef',runIds:['ras-20261114T010101-89abcdef',stable.runIds[0]]}));
 assert.equal((await fi.listCoreFiTasks()).length,tasks);assert.equal((await fi.listCoreFiTasks({includeRuns:true})).flatMap(task=>task.runs).length,runs);
}));

test('FI dispatch reserves real task identities before returning and resumes the same work in the background',async()=>{
 const calls:string[]=[];let physicalWaits=0;const handle={experiment_id:'exp',run_id:'frozen-run',work_item_id:'work',attempt_id:'attempt',case_id:'case',fence:'2',checkpoint_revision:'1',lease_owner:'worker'};
 const request={user:'alice',experimentId:'exp',platform:'opencode',agent:'build',cases:[{caseId:'case',input:'public task',fault:'network'}]};let checkpoint:Record<string,unknown>={};
 const context={operationKey:'request',actor:{username:'alice'},rpc:async(action:string,payload:Record<string,unknown>)=>{calls.push(action);if(action==='execute_start')return {run_id:'frozen-run'};if(action==='claim')return handle;if(action==='load_work')return {execution_request:request,raw_case:{id:'case',input:'public task'},checkpoint};if(action==='checkpoint'){checkpoint=payload.checkpoint as Record<string,unknown>;return {...handle,checkpoint_revision:'2'};}return handle;}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/experiment-fi-worker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>id==='./execution-delivery'?delivery:({
  '@/lib/fault-injection/store':{newTaskKey:()=> 'task-stable',newRunId:()=> 'ras-stable'},
  './experiment-assets':{prepareCoreExperimentStart:async()=>({payload:{experiment_id:'exp'}})},
  './experiment-worker':{activateExperimentWork:async()=>{}},
  '@/lib/engine/experiment/fi-orchestrate':{assertFiExecutionTarget:async()=>{},createFiCaseTask:async(_req:unknown,_case:unknown,identity:{taskKey:string;runIds:string[]})=>{calls.push('physical-create');assert.deepEqual(JSON.parse(JSON.stringify(identity)),{taskKey:'task-stable',runIds:['ras-stable']});return {task:{id:'physical-task'},runs:[{runId:'ras-stable'}]};},findFiRunByKey:async()=>{physicalWaits++;return {runId:'ras-stable',status:'completed',sessionTaskId:'session',user:'alice'};},cancelFiExecution:async()=>{},isCoreFiBusinessTraceReady:async()=>true},
 }[id]??{}),console,setTimeout,clearTimeout,setInterval,clearInterval,AbortController});
 const api=module.exports as {prepareCoreFiDispatch:Function;orchestrateCoreFi:Function};assert.equal(typeof api.prepareCoreFiDispatch,'function');
 const dispatch=await api.prepareCoreFiDispatch(context,request);assert.equal(physicalWaits,0);assert.deepEqual(JSON.parse(JSON.stringify(dispatch.result)),{skipped:false,taskIds:['physical-task'],runIds:['ras-stable'],caseFaults:[{caseId:'case',fault:'network',taskId:'physical-task',runId:'ras-stable'}]});assert.ok(calls.indexOf('checkpoint')<calls.indexOf('physical-create'));
 const outcome=await api.orchestrateCoreFi(context,request,{reservedRunId:dispatch.runId,reservedHandles:dispatch.handles});assert.equal(outcome.runIds[0],'ras-stable');assert.equal(calls.filter(action=>action==='execute_start').length,1);assert.equal(calls.filter(action=>action==='claim').length,1);
});

test('failed cleanup during FI startup never attests that an earlier physical process exited',async()=>{
 const handle={experiment_id:'exp',run_id:'run',work_item_id:'work',attempt_id:'attempt',case_id:'case',fence:'2',checkpoint_revision:'1',lease_owner:'worker'};const failures:Record<string,unknown>[]=[];let created=0;
 const request={user:'alice',experimentId:'exp',platform:'opencode',agent:'build',cases:[{caseId:'case',input:'public',fault:'network'}]};
 const context={operationKey:'request',actor:{username:'alice'},rpc:async(action:string,payload:Record<string,unknown>)=>{if(action==='execute_start')return {run_id:'run'};if(action==='claim')return handle;if(action==='load_work')return {execution_request:request,raw_case:{id:'case',input:'public'},cleanup_required:true,cleanup_target:{kind:'fi',runId:'ras-old',clientId:'client'},checkpoint:{command_id:'fi:ras-old',fi_run_id:'ras-old',cleanup_required:true}};if(action==='execute_fail')failures.push(payload);return handle;}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/experiment-fi-worker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>id==='./execution-delivery'?delivery:({
  '@/lib/fault-injection/store':{newRunId:()=> 'ras-stable'},'./experiment-assets':{prepareCoreExperimentStart:async()=>({payload:{experiment_id:'exp'}})},
  '@/lib/engine/experiment/fi-orchestrate':{assertFiExecutionTarget:async()=>{},createFiCaseTask:async()=>{created++;},cancelFiExecution:async()=>{throw Error('process tree unconfirmed');}},
 }[id]??{}),console,setTimeout,clearTimeout,setInterval,clearInterval,AbortController});
 await assert.rejects((module.exports as {prepareCoreFiDispatch:Function}).prepareCoreFiDispatch(context,request),/unconfirmed/);assert.equal(created,0);assert.equal(failures.length,1);assert.equal(failures[0].cleanup_confirmed,false);
});

test('a prepared FI task is stopped even when its worker loses permission before loading frozen work',async()=>{
 let stopped=0;let created=0;const handle={experiment_id:'exp',run_id:'run',attempt_id:'attempt',case_id:'case',fence:'2',lease_owner:'worker'};
 const context={actor:{username:'alice'},rpc:async(action:string)=>{if(action==='load_work')throw Object.assign(new Error('revoked'),{status:403});return {};}};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/experiment-fi-worker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>id==='./execution-delivery'?delivery:({'@/lib/engine/experiment/fi-orchestrate':{cancelFiExecution:async(user:string,runId:string)=>{assert.equal(user,'alice');assert.equal(runId,'ras-prepared');stopped++;},createFiCaseTask:async()=>{created++;}}}[id]??{}),console,setTimeout,clearTimeout,setInterval,clearInterval,AbortController});
 const result=await (module.exports as {runCoreFiWork:Function}).runCoreFiWork(handle,context,{kind:'fi',runId:'ras-prepared',clientId:'old-client'});assert.equal(result.ready,false);assert.equal(stopped,1);assert.equal(created,0);
});
