import test from 'node:test';
import assert from 'node:assert/strict';
import type {CoreExperimentContext} from '@/lib/storage-core/experiments';

test('cancellation persists its stop command before dispatch and requires the exact client/run receipt',async()=>{
 const {reconcileCoreCancellation}=await import('@/lib/storage-core/experiment-cancellation');
 const events:string[]=[];let command:Record<string,unknown>|null=null;
 let current={id:'cancel',experimentId:'exp',caseKey:'case',revision:'1',status:'pending',error:null,targetsJson:JSON.stringify([{kind:'ordinary',runId:'original',clientId:'client',confirmed:false}])};
 const context={actor:{username:'owner'},rpc:async(action:string,body:Record<string,unknown>)=>{
  if(action==='cancellation_lookup')return structuredClone(current);
  assert.equal(action,'cancellation_update');events.push('persist');current={...current,revision:String(Number(current.revision)+1),status:String(body.status),targetsJson:JSON.stringify(body.targets)};return structuredClone(current);
 }} as unknown as CoreExperimentContext;
 const deps={getCommand:async()=>command,newCommandId:()=> 'cmd_cancel',createCommand:async()=>{events.push('create');return {commandId:'cmd_cancel'};},dispatch:async()=>{events.push('dispatch');},stopFi:async()=>{throw Error('wrong domain');}};
 await reconcileCoreCancellation(context,'cancel',deps);assert.deepEqual(events,['create','persist','dispatch']);assert.equal(current.status,'pending');
 command={commandId:'cmd_cancel',user:'owner',clientId:'another',action:'CANCEL_EXPERIMENT_RUN',status:'SUCCEEDED',payloadJson:JSON.stringify({kind:'ordinary',runId:'original'}),resultJson:JSON.stringify({runId:'original',status:'cancelled'}),expiresAt:new Date(Date.now()+10000)};
 await reconcileCoreCancellation(context,'cancel',deps);assert.equal(current.status,'pending');
 command={...command,clientId:'client',resultJson:JSON.stringify({runId:'stale-original',status:'cancelled'})};await reconcileCoreCancellation(context,'cancel',deps);assert.equal(current.status,'pending');
 command={...command,resultJson:JSON.stringify({runId:'original',status:'cancelled'})};await reconcileCoreCancellation(context,'cancel',deps);assert.equal(current.status,'completed');
});

test('unconfirmed FI cleanup remains pending and never claims a completed cancellation',async()=>{
 const {reconcileCoreCancellation}=await import('@/lib/storage-core/experiment-cancellation');let result:Record<string,unknown>={};
 const current={id:'cancel',experimentId:'exp',caseKey:'case',revision:'1',status:'pending',targetsJson:JSON.stringify([{kind:'fi',runId:'fi-run',clientId:'fi-client',confirmed:false}])};
 const context={actor:{username:'owner'},rpc:async(action:string,body:Record<string,unknown>)=>action==='cancellation_lookup'?structuredClone(current):(result=body,{...current,status:body.status})} as unknown as CoreExperimentContext;
 await reconcileCoreCancellation(context,'cancel',{getCommand:async()=>null,newCommandId:()=>'',createCommand:async()=>{throw Error('wrong domain');},dispatch:async()=>{},stopFi:async()=>{throw Error('process still alive');}});
 assert.equal(result.status,'pending');assert.equal((result.targets as Array<{confirmed:boolean}>)[0].confirmed,false);
});

test('local stop requires the actual actor-bound cleanup hook and unknown instance remains pending',async()=>{
 const {reconcileCoreCancellation}=await import('@/lib/storage-core/experiment-cancellation');let result:Record<string,unknown>={};
 const current={id:'local-cancel',experimentId:'exp',caseKey:'',revision:'1',status:'pending',targetsJson:JSON.stringify([{kind:'local',runId:'attempt',confirmed:false}])};
 const context={actor:{username:'owner',principal:'p',workspace:'w'},rpc:async(action:string,body:Record<string,unknown>)=>action==='cancellation_lookup'?structuredClone(current):(result=body,{...current,status:body.status})} as unknown as CoreExperimentContext;
 const deps={getCommand:async()=>null,newCommandId:()=>'',createCommand:async()=>{throw Error('wrong domain');},dispatch:async()=>{},stopFi:async()=>{throw Error('wrong domain');}};
 await reconcileCoreCancellation(context,'local-cancel',deps);assert.equal(result.status,'pending');
 await reconcileCoreCancellation(context,'local-cancel',{...deps,stopLocal:async(actual,attempt)=>{assert.equal(actual,context);assert.equal(attempt,'attempt');}});assert.equal(result.status,'completed');
});

test('Benchmark cancellation and reconciliation delegate before ordinary target reads',async()=>{
 const {readFileSync}=await import('node:fs');const vm=await import('node:vm');const ts=await import('typescript');const crypto=await import('node:crypto');
 const events:string[]=[];const cancellation={id:'cancel',experimentId:'exp',caseKey:'',revision:'1',status:'pending',targetsJson:'[]'};
 const context={actor:{username:'deleter',workspace:'w',principal:'p'},rpc:async(action:string)=>{events.push(action);assert.equal(action,'cancellation_route');return {kind:'benchmark'};}};
 const dependencies:Record<string,unknown>={'node:crypto':crypto,'@/lib/benchmark/core-cancellation':{maybeCancelCoreBenchmarkExecution:async(actual:unknown)=>{assert.equal(actual,context);events.push('benchmark-cancel');return cancellation;},reconcileCoreBenchmarkCancellation:async(actual:unknown)=>{assert.equal(actual,context);events.push('benchmark-cleanup');return cancellation;}}};
 const module={exports:{}};const code=ts.transpileModule(readFileSync('src/lib/storage-core/experiment-cancellation.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{module,exports:module.exports,require:(name:string)=>{assert.ok(name in dependencies,name);return dependencies[name];},Map,Promise,setTimeout,clearTimeout,setInterval,clearInterval});const api=module.exports as Record<string,Function>;
 assert.equal(await api.cancelCoreExperimentExecution(context,'exp'),cancellation);assert.equal(await api.reconcileCoreCancellation(context,'cancel'),cancellation);
 assert.deepEqual(events,['cancellation_route','benchmark-cancel','cancellation_route','benchmark-cleanup']);
});
