import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prisma} from './helpers/historical-prisma';
import {createExperimentReadView} from '@/lib/storage-core/experiment-view';
import {runWithCoreExperimentContext,type CoreExperimentContext} from '@/lib/storage-core/experiments';
const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';
process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
test.after(async()=>{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;await prisma.$disconnect();database.dispose();});
function fixture(path:string,body:Record<string,unknown>={},method='POST'){
 const calls:Array<{action:string;payload:Record<string,unknown>}> = [];
 const experiment={id:'core-exp',user:'verified-owner',name:'原实验',type:'single',agentName:'build',scope:'',status:'draft',deletedAt:null,evaluatorIdsJson:'["preset-result-answer"]',evaluatorConfigsJson:null,configSnapshotJson:JSON.stringify({coreAssets:{schemaVersion:1,evaluators:{'preset-result-answer':{card:{id:'preset-result-answer'},origin:'builtin'}},releases:{}}}),cases:[] as Array<Record<string,unknown>>,groups:[],comments:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 const request=new Request('http://localhost'+path,{method,headers:{authorization:'Bearer api_'+'R'.repeat(43),'content-type':'application/json'},...(method==='DELETE'?{}:{body:JSON.stringify(body)})});
 const context:CoreExperimentContext={request,body,operationKey:'original-operation',actor:{token:'api_'+'R'.repeat(43),workspace:'w',principal:'owner',username:'verified-owner'},options:{fetcher:async(url,init)=>{if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'owner',username:'verified-owner',workspace_id:'w',workspaces:[{workspace_id:'w'}]});assert.equal(new URL(String(url)).pathname,'/v1/compat/platform-control');const body=JSON.parse(String(init?.body));assert.equal(body.action,'records_read');assert.equal(body.kind,'userSettings');return Response.json({value:{rows:[],scope_revision:'0'}});}},readView:createExperimentReadView([{coverage:'complete',experiment,executions:[],sessions:[],cancellations:[]}]),rpc:async(action,payload={})=>{
  calls.push({action,payload});if(action==='cancellation_route')return {kind:'ordinary'};if(action==='read')return {experiment,revision:'1'};if(action==='update'){Object.assign(experiment,payload.changes);return {experiment,revision:'2'};}
  if(action==='case_upsert'){const row={...(payload.case as Record<string,unknown>),id:'added-case'};experiment.cases.push(row);return {experiment,case_id:row.id};}
  if(action==='start'){experiment.status='running';return {experiment,run_id:'immutable-run'};}if(action==='claim')return null;return {experiment};
 }};return {calls,experiment,request,context,run:<T>(fn:()=>Promise<T>)=>runWithCoreExperimentContext(context,fn)};
}
const params={params:Promise.resolve({id:'core-exp'})};

test('rename writes the authorized core head and keeps the original response without a legacy row',async()=>{
 const {PATCH}=await import('@/app/api/experiments/[id]/route');const f=fixture('/api/experiments/core-exp',{user:'forged',name:'  已改名  '},'PATCH');const before=await prisma.experiment.count();
 const response=await f.run(()=>PATCH(f.request,params));assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true,name:'已改名'});assert.deepEqual(f.calls.find(call=>call.action==='update')?.payload.changes,{name:'已改名'});assert.equal(await prisma.experiment.count(),before);
});

test('append-only cases retain the original added/reused DTO and never create a legacy case',async()=>{
 const {POST}=await import('@/app/api/experiments/[id]/cases/route');const f=fixture('/api/experiments/core-exp/cases',{user:'forged',autoRun:false,cases:[{taskId:'t',input:'问题',actualOutput:'答案',referenceOutput:'参考'}]});const before=await prisma.experimentCase.count();
 const response=await f.run(()=>POST(f.request,params));assert.equal(response.status,200);assert.deepEqual(await response.json(),{added:1,reused:0,caseIds:['added-case'],evaluating:false});assert.equal(f.calls.filter(call=>call.action==='case_upsert').length,1);assert.equal(await prisma.experimentCase.count(),before);
});

test('the original run endpoint starts an immutable core RunPlan without an old Experiment row',async()=>{
 const {POST}=await import('@/app/api/experiments/[id]/run/route');const f=fixture('/api/experiments/core-exp/run');f.experiment.cases.push({id:'case',input:'问题',actualOutput:'答案'});
 const response=await f.run(()=>POST(f.request,params));assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'running'});assert.equal(f.calls.filter(call=>call.action==='start').length,1);assert.equal(await prisma.experiment.count(),0);
});

test('a core run already in progress is returned without scheduling it again',async()=>{
 const {POST}=await import('@/app/api/experiments/[id]/run/route');const f=fixture('/api/experiments/core-exp/run');f.experiment.status='running';
 const response=await f.run(()=>POST(f.request,params));assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'running',alreadyRunning:true});assert.equal(f.calls.filter(call=>call.action==='start').length,0);
});

test('stop-watching and rename validation keep their original wire responses',async()=>{
 const {PATCH}=await import('@/app/api/experiments/[id]/route');const f=fixture('/api/experiments/core-exp',{watchMode:false},'PATCH');
 const response=await f.run(()=>PATCH(f.request,params));assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true,watchMode:false});assert.deepEqual(f.calls.find(call=>call.action==='update')?.payload.changes,{watchMode:false});
 for(const body of [{name:' '},{name:'valid',watchMode:false},{watchMode:true}]){const invalid=fixture('/api/experiments/core-exp',body,'PATCH');const result=await invalid.run(()=>PATCH(invalid.request,params));assert.equal(result.status,400);assert.equal(invalid.calls.length,0);}
});

test('draft compensation deletion uses an atomic draft-only core command',async()=>{
 const {DELETE}=await import('@/app/api/experiments/[id]/route');const f=fixture('/api/experiments/core-exp',{},'DELETE');const previous=f.context.rpc;
 f.context.rpc=async(action,payload={})=>{if(action==='remove'){f.calls.push({action,payload});return {cancellation:{id:'cancel',experimentId:'core-exp',caseKey:'',revision:'1',status:'completed',targetsJson:'[]'}};}return previous(action,payload);};
 const response=await f.run(()=>DELETE(f.request,params));assert.equal(response.status,200);assert.deepEqual(await response.json(),{deleted:true});assert.equal(f.calls.find(call=>call.action==='remove')?.payload.draft_only,true);
 const running=fixture('/api/experiments/core-exp',{},'DELETE');running.experiment.status='running';const rejected=await running.run(()=>DELETE(running.request,params));assert.equal(rejected.status,409);assert.equal(running.calls.filter(call=>call.action==='remove').length,0);
});

test('case deletion preserves cancellation and deleted flags from the authorized core command',async()=>{
 const {DELETE}=await import('@/app/api/experiments/[id]/cases/[caseId]/route');const f=fixture('/api/experiments/core-exp/cases/case',{},'DELETE');const previous=f.context.rpc;const cancellation={id:'cancel',experimentId:'core-exp',caseKey:'case',revision:'1',status:'completed',targetsJson:'[]'};
 f.context.rpc=async(action,payload={})=>{if(action==='case_remove'){f.calls.push({action,payload});return {cancellation};}return previous(action,payload);};
 const response=await f.run(()=>DELETE(f.request,{params:Promise.resolve({id:'core-exp',caseId:'case'})}));assert.equal(response.status,200);assert.deepEqual(await response.json(),{deleted:true,experimentDeleted:false,cancellation});assert.equal(f.calls.find(call=>call.action==='case_remove')?.payload.case_id,'case');
});

test('result retry retains a claim conflict and missing-result behavior without a false score',async()=>{
 const {POST}=await import('@/app/api/experiments/[id]/results/[resultId]/retry/route');const f=fixture('/api/experiments/core-exp/results/result/retry');f.experiment.cases.push({id:'case',input:'input',results:[{id:'result',status:'failed',evaluatorId:'preset-result-answer'}]});
 const response=await f.run(()=>POST(f.request,{params:Promise.resolve({id:'core-exp',resultId:'result'})}));assert.equal(response.status,409);assert.equal(f.calls.find(call=>call.action==='retry')?.payload.result_id,'result');
 const missing=fixture('/api/experiments/core-exp/results/missing/retry');const rejected=await missing.run(()=>POST(missing.request,{params:Promise.resolve({id:'core-exp',resultId:'missing'})}));assert.equal(rejected.status,404);assert.equal(missing.calls.some(call=>call.action==='retry'),false);
});

test('case retry retains active-evaluation and no-failed-items preconditions without old rows',async()=>{
 const {POST}=await import('@/app/api/experiments/[id]/cases/[caseId]/retry/route');
 for(const results of [[{id:'result',status:'pending'}],[{id:'result',status:'done'}]]){
  const f=fixture('/api/experiments/core-exp/cases/case/retry');f.experiment.cases.push({id:'case',input:'input',results});const response=await f.run(()=>POST(f.request,{params:Promise.resolve({id:'core-exp',caseId:'case'})}));assert.equal(response.status,409);assert.equal(f.calls.some(call=>call.action==='retry'),false);
 }
});

test('generated-Trace start retains the no-eligible-Case precondition before transport',async()=>{
 const {POST}=await import('@/app/api/experiments/[id]/run/route');const f=fixture('/api/experiments/core-exp/run',{traceSource:'generate',generateTrace:{workerId:'client',platform:'opencode',agent:'build'}});
 const response=await f.run(()=>POST(f.request,params));assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'没有可生成 Trace 的 Case，未启动评估'});assert.equal(f.calls.some(call=>call.action==='execute_start'),false);
});

test('the core Case retry keeps the original lock until background Trace generation finishes',async()=>{
 const fs=await import('node:fs');const vm=await import('node:vm');const ts=await import('typescript');let release!:()=>void;const completion=new Promise<void>(resolve=>{release=resolve;});let reservations=0;
 const context={actor:{username:'owner',principal:'p',workspace:'w'},rpc:async()=>({experiment:{cases:[{id:'case',input:'task',results:[],traceAttempts:[{id:'old',kind:'ordinary',status:'failed'}]}]}})};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/storage-core/experiment-routes.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>({
  './experiments':{requireCoreExperimentContext:()=>context},
  './experiment-trace-worker':{prepareCoreTraceRun:async()=>{reservations++;return 'run';}},
  '@/lib/engine/experiment/trace-generation':{loadTraceGenerationRetryRequest:async()=>({cases:[{caseId:'case'}]}),generateExperimentTraces:()=>completion},
 }[id]??{}),console,Response,Symbol,Set});
 const retry=(module.exports as {retryCoreExperimentCaseRoute:Function}).retryCoreExperimentCaseRoute;
 const first=await retry('exp','case');assert.equal(first.status,200);const second=await retry('exp','case');assert.equal(second.status,409);assert.equal(reservations,1);release();await new Promise(resolve=>setImmediate(resolve));
 const third=await retry('exp','case');assert.equal(third.status,200);assert.equal(reservations,2);
});

test('fixed Benchmark inputs cannot be changed through generic Case append',async()=>{
 const {POST}=await import('@/app/api/experiments/[id]/cases/route');const f=fixture('/api/experiments/core-exp/cases',{autoRun:false,cases:[{input:'replacement input'}]});f.experiment.scope='benchmark';
 const response=await f.run(()=>POST(f.request,params));assert.equal(response.status,409);assert.equal(f.calls.filter(call=>call.action==='case_upsert').length,0);
});

test('the original Benchmark Case retry POST returns its 202 DTO and keeps the lock until background dispatch settles',async()=>{
 const {POST}=await import('@/app/api/experiments/[id]/cases/[caseId]/retry/route');const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');
 const directory=await mkdtemp(path.join(os.tmpdir(),'benchmark-route-retry-'));const controller=path.join(directory,'controller');await writeFile(controller,'a'.repeat(64),{mode:0o600});const old=process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=controller;
 let release!:()=>void;const completion=new Promise<void>(resolve=>{release=resolve;});let claiming!:()=>void;const claimed=new Promise<void>(resolve=>{claiming=resolve;});const benchmarkCalls:string[]=[];let committed=false;
 const f=fixture('/api/experiments/core-exp/cases/case/retry',{user:'forged'});f.experiment.scope='benchmark';f.experiment.status='done';f.experiment.cases.push({id:'case',input:'frozen input',results:[{id:'primary',evaluatorId:'benchmark:fixture',status:'done'}]});
 const started={status:'running',alreadyRunning:false,runId:'erun_new',runplanId:'immutable-retry'};const original=f.context.options.fetcher!;
 f.context.options.fetcher=async(url,options)=>{
  if(!String(url).includes('/v1/compat/benchmarks'))return original(url,options);
  const body=JSON.parse(String(options?.body));benchmarkCalls.push(body.action);
  if(body.action==='lookup_operation')return Response.json({value:committed?started:null});
  assert.ok(new Headers(options?.headers).get('x-storage-controller-proof')||body.action==='claim');
  if(body.action==='prepare_case_retry')return Response.json({value:{previous_job_id:'erun_old',expected_machine_result_id:'original-machine'}});
  if(body.action==='retry_case'){assert.equal(body.case_id,'case');assert.equal(body.previous_job_id,'erun_old');assert.equal(body.expected_machine_result_id,'original-machine');committed=true;return Response.json({value:started});}
  assert.equal(body.action,'claim');assert.equal(body.job_id,'erun_new');claiming();await completion;return Response.json({value:null});
 };
 const retryParams={params:Promise.resolve({id:'core-exp',caseId:'case'})};
 try{
  const first=await f.run(()=>POST(f.request,retryParams));assert.equal(first.status,202);const value=await first.json();assert.deepEqual(value,{kind:'benchmark',status:'running',runId:'erun_new'});assert.equal('completion' in value,false);await claimed;
  const duplicate=await f.run(()=>POST(f.request,retryParams));assert.equal(duplicate.status,409);assert.equal((await duplicate.json()).code,'case_retry_in_progress');assert.equal(benchmarkCalls.filter(action=>action==='retry_case').length,1);
  release();await new Promise(resolve=>setImmediate(resolve));const replay=await f.run(()=>POST(f.request,retryParams));assert.equal(replay.status,202);assert.deepEqual(await replay.json(),value);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(benchmarkCalls.filter(action=>action==='prepare_case_retry').length,1);assert.equal(f.calls.some(call=>['retry','start','execute_start'].includes(call.action)),false);
  for(const table of ['experiment','experimentCase','experimentEvalResult','benchmarkCaseRun','benchmarkEvaluation'] as const)assert.equal(await (prisma[table] as {count():Promise<number>}).count(),0);
 }finally{release();await new Promise(resolve=>setImmediate(resolve));if(old===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=old;await rm(directory,{recursive:true,force:true});}
});
