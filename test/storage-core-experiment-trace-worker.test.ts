import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as delivery from '../src/lib/storage-core/execution-delivery';
const handle={experiment_id:'exp',run_id:'run',work_item_id:'work',attempt_id:'attempt',case_id:'case',result_id:'',evaluator_id:'',fence:'3',lease_owner:'worker',lease_until_ms:Date.now()+30000,checkpoint_revision:'1',plan_hash:'a'.repeat(64)};
const request={user:'alice',experimentId:'exp',workerId:'client',platform:'opencode',agent:'build',model:'m',cases:[{caseId:'case',input:'PUBLIC INPUT'}]};
function load(dependencies:Record<string,unknown>,globals:Record<string,unknown>={}){
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/storage-core/experiment-trace-worker.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(key:string)=>key==='./execution-delivery'?delivery:dependencies[key]??{},setTimeout,clearTimeout,setInterval,clearInterval,AbortController,AbortSignal,console,...globals});return module.exports as Record<string,Function>;
}
function fixture(overrides:Record<string,unknown>={},globals:Record<string,unknown>={}){
 const calls:Array<{action:string;payload:Record<string,unknown>}>=[];let dispatched=false;
 const ctx={actor:{username:'alice',workspace:'ws',principal:'p'},operationKey:'http',rpc:async(action:string,payload:Record<string,unknown>):Promise<unknown>=>{calls.push({action,payload});if(action==='load_work')return {handle,raw_case:{id:'case',input:'PUBLIC INPUT',referenceOutput:'SECRET GOLD'},execution_request:request,checkpoint:{}};if(action==='checkpoint')return {...handle,checkpoint_revision:'2'};return {};}};
 const dependencies={
  'node:crypto':{randomUUID:()=> 'stable'},
  './experiment-assets':{prepareCoreExperimentStart:async()=>({payload:{experiment_id:'exp'}})},
  '@/lib/engine/experiment/execution-concurrency':{mapConcurrent:async(rows:unknown[],_n:number,fn:(row:unknown)=>unknown)=>Promise.all(rows.map(fn)),parseExecutionConcurrency:()=>1},
  './experiments':{runWithCoreExperimentContext:async(_ctx:unknown,fn:Function)=>fn()},
  '@/lib/engine/experiment/trace-generation':{
   AUTO_RETRY_DELAYS_MS:[0,0],findExecutionByTraceId:async()=>({id:'execution'}),assertTraceGenerationTarget:async()=>({}),traceIdFromCompletedCommand:async()=> 'trace',
   waitForCommand:async()=>({status:'SUCCEEDED',clientId:'client',resultJson:'{"traceId":"trace"}'}),
   dispatchTraceGenerationCommand:async()=>{dispatched=true;},cancelTraceGenerationCommand:async()=>{},
   isTraceGenerationFailureRetryable:()=>false,
  },
  '@/lib/reliability/command-bus':{newCommandId:()=> 'cmd_stable',getCommand:async()=>null,createCommand:async(input:Record<string,unknown>)=>{calls.push({action:'createCommand',payload:input});return {commandId:'cmd_stable'};}},
  './experiment-worker':{activateExperimentWork:async()=>{}},
  ...overrides,
 };return {calls,ctx,api:load(dependencies,globals),get dispatched(){return dispatched;}};
}
test('core Trace execution fences command identity before transport and only sends public input',async()=>{
 const f=fixture();assert.equal(typeof f.api.runCoreTraceWork,'function');await f.api.runCoreTraceWork(handle,f.ctx);
 const checkpoint=f.calls.findIndex(c=>c.action==='checkpoint');const command=f.calls.findIndex(c=>c.action==='createCommand');assert.ok(checkpoint>=0&&checkpoint<command);
 assert.equal(f.calls[checkpoint].payload.command_id,'cmd_stable');assert.equal(f.dispatched,true);
 assert.ok(!JSON.stringify(f.calls[command]).includes('SECRET GOLD'));assert.ok(f.calls.some(c=>c.action==='execute_complete'));
});
test('failure to freeze a command prevents any client command creation or dispatch',async()=>{
 const f=fixture();const original=f.ctx.rpc;f.ctx.rpc=async(action,payload)=>{if(action==='checkpoint')throw Object.assign(new Error('stale'),{status:409});return original(action,payload);};
 await f.api.runCoreTraceWork(handle,f.ctx);assert.equal(f.dispatched,false);assert.equal(f.calls.filter(c=>c.action==='createCommand').length,0);
});

test('trusted core command callback preserves Trace facts without touching legacy Experiment tables',async()=>{
 let writes:Record<string,unknown>|undefined;let shadow=0;
 const row={commandId:'cmd_core',clientId:'client',action:'RUN_EXPERIMENT_CASE',status:'RUNNING',expiresAt:new Date(Date.now()+30000),payloadJson:JSON.stringify({correlation:{storageCore:true}}),resultJson:null};
 const store={reliabilityCommand:{findUnique:async()=>row,updateMany:async(input:{data:Record<string,unknown>})=>{writes=input.data;return {count:1};}},experimentTraceAttempt:new Proxy({},{get(){shadow++;throw Error('legacy forbidden');}}),$transaction:async(fn:Function)=>fn(store)};
 const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/reliability/command-bus.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>({
  '@/lib/storage/prisma':{prisma:store},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>false},'@/lib/trace-reference':{mergeTraceFacts:(_old:unknown,next:unknown)=>next,traceIdFromFacts:(value:{traceId:string})=>value.traceId},'@/lib/reliability/client-registry':{ReliabilityError:Error},'../../../packages/benchmark-protocol/environment.cjs':{},
 }[id]??{}),console});
 await (module.exports as {applyCommandStatus:Function}).applyCommandStatus({commandId:'cmd_core',clientId:'client',status:'SUCCEEDED',result:{traceId:'core-trace'}});
 assert.equal(shadow,0);assert.equal(writes?.resultJson,'{"traceId":"core-trace"}');
 row.payloadJson='{}';
 await (module.exports as {applyCommandStatus:Function}).applyCommandStatus({commandId:'cmd_core',clientId:'client',status:'SUCCEEDED',result:{traceId:'trace',correlation:{storageCore:true}}});
 assert.equal(shadow,0);assert.equal(JSON.parse(String(writes?.resultJson)).traceId,'trace');
});

 test('lease loss requests real cancellation and unconfirmed cleanup forbids retry or score',async()=>{
 let tick:()=>void=()=>{};let cancellations=0;
 const f=fixture({
  '@/lib/engine/experiment/trace-generation':{assertTraceGenerationTarget:async()=>{},dispatchTraceGenerationCommand:async()=>{},waitForCommand:async(_id:string,_ms:number,signal:AbortSignal)=>{tick();return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},cancelTraceGenerationCommand:async()=>{cancellations++;throw Object.assign(new Error('tree unconfirmed'),{code:'EVALUATION_CLEANUP_UNCONFIRMED'});},isTraceGenerationFailureRetryable:()=>true},
 },{setInterval:(fn:()=>void)=>{tick=fn;return 1;},clearInterval:()=>{}});
 const original=f.ctx.rpc;f.ctx.rpc=async(action,payload)=>{if(action==='renew')throw Object.assign(new Error('expired'),{status:409});return original(action,payload);};
 const outcome=await f.api.runCoreTraceWork(handle,f.ctx);assert.equal(outcome.ready,false);assert.equal(outcome.retryable,false);assert.equal(cancellations,1);
 const failed=f.calls.find(c=>c.action==='execute_fail')!;assert.equal(failed.payload.cleanup_confirmed,false);assert.ok(!f.calls.some(c=>c.action==='execute_complete'));
});

test('stable client command identity resumes the same immutable payload and rejects substitution',async()=>{
 let row:Record<string,unknown>|null=null;let created=0;
 const store={reliabilityCommand:{findUnique:async()=>row,create:async({data}:{data:Record<string,unknown>})=>{created++;row={...data,createdAt:new Date()};return row;}}};
 const module={exports:{}};class Failure extends Error{constructor(public code:string,message:string,public status:number){super(message);}}
 vm.runInNewContext(ts.transpileModule(readFileSync('src/lib/reliability/command-bus.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>({'@/lib/storage/prisma':{prisma:store},'@/lib/reliability/client-registry':{ReliabilityError:Failure}}[id]??{}),console,process});
 const api=module.exports as {createCommand:Function};const request={user:'alice',clientId:'client',action:'RUN_EXPERIMENT_CASE',commandId:'cmd_stable',payload:{input:'frozen public',correlation:{storageCore:true}}};
 const first=await api.createCommand(request);const second=await api.createCommand(request);assert.equal(created,1);assert.equal(first.commandId,second.commandId);assert.equal(first.expiresAt,second.expiresAt);
 await assert.rejects(api.createCommand({...request,payload:{input:'changed'}}),(error:unknown)=>(error as Failure).code==='COMMAND_ID_CONFLICT');
});

test('command success waits for indexed source acceptance without rerunning the Agent',async()=>{
 const f=fixture();let completions=0;const original=f.ctx.rpc;
 f.ctx.rpc=async(action,payload)=>{if(action==='lookup_operation')return {found:false};if(action==='execute_complete'&&++completions===1)throw Object.assign(new Error('source not indexed'),{status:503});return original(action,payload);};
 const outcome=await f.api.runCoreTraceWork(handle,f.ctx);assert.equal(outcome.ready,true);assert.equal(completions,2);assert.equal(f.calls.filter(c=>c.action==='createCommand').length,1);
});

test('lost Trace completion acknowledgement confirms its exact receipt without cleanup or redispatch',async()=>{
 const f=fixture();const original=f.ctx.rpc;let attempts=0;let key:unknown;let request:unknown;
 f.ctx.rpc=async(action,payload)=>{if(action==='execute_complete'){attempts++;key=payload.operation_key;request=payload.operation_request;throw new TypeError('lost after commit');}if(action==='lookup_operation'){assert.equal(payload.operation_key,key);assert.deepEqual(payload.operation_request,request);return {found:true,result:{execution_run_id:'run'}};}return original(action,payload);};
 assert.equal((await f.api.runCoreTraceWork(handle,f.ctx)).ready,true);assert.equal(attempts,1);assert.equal(f.calls.filter(c=>c.action==='createCommand').length,1);assert.ok(!f.calls.some(c=>c.action==='execute_fail'));
});

test('unconfirmed Trace completion preserves its checkpoint instead of fabricating execution failure',async()=>{
 const f=fixture();const original=f.ctx.rpc;
 f.ctx.rpc=async(action,payload)=>{if(action==='execute_complete')throw new TypeError('lost');if(action==='lookup_operation')return {found:false};return original(action,payload);};
 await assert.rejects(f.api.runCoreTraceWork(handle,f.ctx),error=>delivery.isCoreDeliveryUncertain(error));assert.ok(!f.calls.some(c=>c.action==='execute_fail'));assert.equal(f.calls.filter(c=>c.action==='createCommand').length,1);
});

test('a confirmed previous attempt receives a fresh command identity on retry',async()=>{
 const f=fixture();const original=f.ctx.rpc;f.ctx.rpc=async(action,payload)=>{
  if(action==='load_work')return {handle,raw_case:{id:'case',input:'public'},execution_request:request,checkpoint:{command_id:'cmd_expired',cleanup_confirmed:true}};
  return original(action,payload);
 };
 const outcome=await f.api.runCoreTraceWork(handle,f.ctx);assert.equal(outcome.ready,true);
 const command=f.calls.find(c=>c.action==='createCommand')!;assert.equal(command.payload.commandId,'cmd_stable');
});

test('indexed early Trace fragments do not bypass original completed-session readiness',async()=>{
 let readiness=0;
 const f=fixture({'@/lib/engine/experiment/trace-generation':{
  assertTraceGenerationTarget:async()=>{},dispatchTraceGenerationCommand:async()=>{},waitForCommand:async()=>({status:'SUCCEEDED',clientId:'client',resultJson:'{}'}),traceIdFromCompletedCommand:async()=> 'trace',findExecutionByTraceId:async()=>++readiness<2?null:{id:'execution'},cancelTraceGenerationCommand:async()=>{},isTraceGenerationFailureRetryable:()=>false,
 }});
 const result=await f.api.runCoreTraceWork(handle,f.ctx);assert.equal(result.ready,true);assert.equal(readiness,2);assert.equal(f.calls.filter(c=>c.action==='execute_complete').length,1);
});

test('a superseded Skill callback closes its claim without creating a client command',async()=>{
 const f=fixture();const original=f.ctx.rpc;f.ctx.rpc=async(action,payload)=>{if(action==='execute_start')return {run_id:'run'};if(action==='claim')return {...handle,attempt_no:1};return original(action,payload);};
 await assert.rejects(f.api.generateCoreExperimentTraces(f.ctx,{...request,onAttemptCreated:async()=>{throw Error('superseded callback');}}),/superseded callback/);
 assert.equal(f.calls.filter(c=>c.action==='createCommand').length,0);assert.ok(f.calls.some(c=>c.action==='execute_fail'));
});

test('retry cleans the sealed previous client and cannot assert success after unconfirmed prior cleanup',async()=>{
 const clients:string[]=[];
 const f=fixture({'@/lib/engine/experiment/trace-generation':{assertTraceGenerationTarget:async()=>{},cancelTraceGenerationCommand:async(_user:string,client:string)=>{clients.push(client);throw Error('prior process still alive');},isTraceGenerationFailureRetryable:()=>true}});
 const original=f.ctx.rpc;f.ctx.rpc=async(action,payload)=>action==='load_work'?{handle,raw_case:{id:'case',input:'public'},execution_request:{...request,workerId:'new-client'},checkpoint:{command_id:'cmd_old'},cleanup_required:true,cleanup_target:{kind:'ordinary',runId:'cmd_old',clientId:'old-client'}}:original(action,payload);
 const result=await f.api.runCoreTraceWork(handle,f.ctx);assert.equal(result.ready,false);assert.deepEqual(clients,['old-client']);assert.equal(f.calls.find(call=>call.action==='execute_fail')?.payload.cleanup_confirmed,false);assert.equal(f.calls.filter(call=>call.action==='createCommand').length,0);
});
