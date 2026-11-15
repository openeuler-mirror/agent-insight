import {createHash} from 'node:crypto';
import {runWithCoreExperimentContext,type CoreExperimentContext} from '@/lib/storage-core/experiments';
import type {CoreCancellation} from '@/lib/storage-core/experiment-cancellation';
import {readCoreBytes} from '@/lib/storage-core/server';
import {benchmarkCoreRpc} from './core-store';

type Target={jobId:string;runId:string;requestHash:string;requestDigest:string;kind:'benchmark'|'evaluation'|'native-evaluate';experiment_id?:string;attempt_id?:string;work_item_id?:string;run_id?:string;fence?:string;lease_owner?:string;actor_principal_id?:string;confirmed:boolean;clientId?:string;legacyOwner?:string;baseUrl?:string;commandId?:string};
type Load={handled:boolean;experiment_deleted?:boolean;cancellation?:CoreCancellation;targets?:Target[]};
interface Dependencies {
 getCommand:(id:string)=>Promise<Record<string,unknown>|null>;
 validateClient:(clientId:string,owner:string)=>Promise<void>;
 newCommandId:()=>string;
 createCommand:(input:{user:string;clientId:string;commandId:string;action:'CANCEL_EXPERIMENT_RUN';payload:Record<string,unknown>})=>Promise<{commandId:string;[key:string]:unknown}>;
 dispatch:(clientId:string,frame:{commandId:string;[key:string]:unknown})=>Promise<void>;
 stopNative:(context:CoreExperimentContext,target:import('@/lib/storage-core/experiment-worker').CoreEvaluationTarget)=>Promise<unknown>;
 fetcher:typeof fetch;
}
const key=Symbol.for('agent-insight.storage-core.benchmark-cancellations');
const shared=globalThis as unknown as Record<symbol,{inflight:Map<string,Promise<CoreCancellation|null>>;pending:Map<string,{context:CoreExperimentContext;id:string}>;timer?:ReturnType<typeof setInterval>;sweeping:boolean}>;
const state=shared[key] ||= {inflight:new Map(),pending:new Map(),sweeping:false};
const identity=(context:CoreExperimentContext,id:string)=>context.actor.workspace+':'+context.actor.principal+':'+id;
function deleted(record:CoreCancellation,value:boolean){Object.defineProperty(record,'coreExperimentDeleted',{value,configurable:true,enumerable:false});return record;}
const status=(error:unknown)=>error&&typeof error==='object'&&'status'in error?Number(error.status):undefined;
function parse(value:unknown):Record<string,unknown>{try{const row=JSON.parse(String(value||'{}'));return row&&typeof row==='object'&&!Array.isArray(row)?row:{};}catch{return {};}}
async function dependencies(context:CoreExperimentContext):Promise<Dependencies>{
 const bus=await import('@/lib/reliability/command-bus');const transport=await import('@/lib/engine/experiment/trace-generation');const {prisma}=await import('@/lib/storage/prisma');const worker=await import('@/lib/storage-core/experiment-worker');
 return {stopNative:worker.stopCoreEvaluationAttempt,getCommand:async id=>await bus.getCommand(id) as unknown as Record<string,unknown>|null,newCommandId:bus.newCommandId,createCommand:bus.createCommand as Dependencies['createCommand'],dispatch:async(client,frame)=>transport.dispatchTraceGenerationCommand(client,frame as Awaited<ReturnType<typeof bus.createCommand>>),fetcher:context.options.fetcher||fetch,validateClient:async(clientId,owner)=>{if(!await prisma.reliabilityClient.findFirst({where:{clientId,user:owner,unboundAt:null}}))throw Object.assign(new Error('Frozen Benchmark cancellation client unavailable'),{status:409});}};
}
function register(context:CoreExperimentContext,id:string){
 const idKey=identity(context,id);if(state.pending.has(idKey)||state.pending.size<1000)state.pending.set(idKey,{context,id});if(state.timer)return;
 state.timer=setInterval(()=>{if(state.sweeping)return;state.sweeping=true;void(async()=>{for(const [entry,value] of Array.from(state.pending).slice(0,20)){state.pending.delete(entry);try{const current=await reconcileCoreBenchmarkCancellation(value.context,value.id);if(current&&current.status!=='completed')state.pending.set(entry,value);}catch(error){if(![401,403].includes(status(error)||0))state.pending.set(entry,value);}}})().finally(()=>{state.sweeping=false;});},3000);state.timer.unref?.();
}

export async function maybeCancelCoreBenchmarkExecution(context:CoreExperimentContext,experimentId:string,options:{caseId?:string;deleteExperiment?:boolean;draftOnly?:boolean}={}):Promise<CoreCancellation|null>{
 return runWithCoreExperimentContext(context,async()=>{const result=await benchmarkCoreRpc<{handled:boolean;experiment_deleted?:boolean;cancellation?:CoreCancellation}>('cancel_request',{experiment_id:experimentId,mode:options.deleteExperiment?'remove':options.caseId?'case_remove':'cancel',...(options.caseId?{case_id:options.caseId}:{}),...(options.draftOnly?{draft_only:true}:{})});if(result.handled===false)return null;if(result.handled!==true)throw Object.assign(new Error('Typed Benchmark discriminator response unavailable'),{status:502});if(typeof result.experiment_deleted!=='boolean')throw Object.assign(new Error('Typed Benchmark deletion state unavailable'),{status:502});if(!result.cancellation)throw Object.assign(new Error('Typed Benchmark cancellation receipt unavailable'),{status:502});deleted(result.cancellation,result.experiment_deleted===true);if(result.cancellation.status==='completed')return result.cancellation;register(context,result.cancellation.id);return await reconcileCoreBenchmarkCancellation(context,result.cancellation.id)||result.cancellation;});
}

export async function reconcileCoreBenchmarkCancellation(context:CoreExperimentContext,id:string,injected?:Dependencies):Promise<CoreCancellation|null>{
 const idKey=identity(context,id);const prior=state.inflight.get(idKey);if(prior)return prior;
 const task=runWithCoreExperimentContext(context,async()=>{
  const loaded=await benchmarkCoreRpc<Load>('cancel_load',{cancellation_id:id});if(loaded.handled===false)return null;if(loaded.handled!==true)throw Object.assign(new Error('Typed Benchmark discriminator response unavailable'),{status:502});if(typeof loaded.experiment_deleted!=='boolean')throw Object.assign(new Error('Typed Benchmark deletion state unavailable'),{status:502});let current=loaded.cancellation!;if(!current||!Array.isArray(loaded.targets))throw Object.assign(new Error('Typed Benchmark cancellation targets unavailable'),{status:502});deleted(current,loaded.experiment_deleted===true);if(current.status==='completed'){state.pending.delete(idKey);return current;}const deps=injected||await dependencies(context);
  const write=async(action:'cancel_dispatch_bind'|'cleanup_confirm',target:Target,body:Record<string,unknown>)=>{const payload={experiment_id:current.experimentId,cancellation_id:id,expected_revision:current.revision,target_id:target.jobId,...body};const hash=createHash('sha256').update(JSON.stringify(payload)).digest('hex');current=await benchmarkCoreRpc<CoreCancellation>(action,{...payload,operation_key:'benchmark-cancel:'+action+':'+id+':'+hash,operation_request:payload});deleted(current,loaded.experiment_deleted===true);return current;};
  for(const target of loaded.targets){
   if(target.confirmed)continue;
   if(target.kind==='native-evaluate'){
    const descriptor={experiment_id:target.experiment_id!,attempt_id:target.attempt_id!,work_item_id:target.work_item_id!,run_id:target.run_id!,fence:target.fence!,lease_owner:target.lease_owner!,actor_principal_id:target.actor_principal_id!};if(Object.values(descriptor).some(value=>typeof value!=='string'||!value))throw Object.assign(new Error('Native cancellation descriptor unavailable'),{status:502});let proof:unknown;try{proof=await deps.stopNative(context,descriptor);}catch(error){if(status(error)===503)continue;throw error;}await write('cleanup_confirm',target,{proof});continue;
   }
   if(target.kind==='evaluation'){
    const url=new URL(target.baseUrl!);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Object.assign(new Error('Frozen Benchmark cancellation target invalid'),{status:409});
    let response:Response;try{response=await deps.fetcher(target.baseUrl!.replace(/\/$/,'')+'/api/v1/evaluations',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({operation:'cancel',runId:target.runId,requestDigest:target.requestDigest}),signal:AbortSignal.timeout(3000)});}catch{continue;}
    if(![200,202].includes(response.status))continue;let result:Record<string,unknown>;try{result=JSON.parse(Buffer.from(await readCoreBytes(response.body,65536)).toString('utf8'));}catch{continue;}if(result.runId!==target.runId||result.status!=='cancelled')continue;
    await write('cleanup_confirm',target,{proof:{transport:'evaluator-http',base_url:target.baseUrl,run_id:target.runId,request_digest:target.requestDigest,http_status:response.status,result:{runId:result.runId,status:result.status}}});continue;
   }
   if(target.kind!=='benchmark'||!target.clientId||!target.legacyOwner)throw Object.assign(new Error('Frozen Benchmark cancellation owner unavailable'),{status:409});await deps.validateClient(target.clientId,target.legacyOwner);let command=target.commandId?await deps.getCommand(target.commandId):null;
   if(command){const payload=parse(command.payloadJson);if(command.commandId!==target.commandId||command.user!==target.legacyOwner||command.clientId!==target.clientId||command.action!=='CANCEL_EXPERIMENT_RUN'||payload.kind!=='benchmark'||payload.runId!==target.runId||payload.requestDigest!==target.requestDigest)throw Object.assign(new Error('Benchmark cancellation command provenance differs'),{status:409});}
   const envelope=parse(command?.resultJson);const result=envelope.result&&typeof envelope.result==='object'?envelope.result as Record<string,unknown>:envelope;
   if(command?.status==='SUCCEEDED'&&result.runId===target.runId&&result.status==='cancelled'){await write('cleanup_confirm',target,{proof:{transport:'device-command',command_id:target.commandId,client_id:target.clientId,legacy_owner:target.legacyOwner,kind:'benchmark',run_id:target.runId,request_digest:target.requestDigest,command_status:'SUCCEEDED',result:{runId:result.runId,status:result.status}}});continue;}
   const expired=command&&Number.isFinite(new Date(String(command.expiresAt)).getTime())&&new Date(String(command.expiresAt)).getTime()<=Date.now();
   const replace=command&&(expired||['FAILED','EXPIRED','DELIVERY_FAILED'].includes(String(command.status))||command.status==='SUCCEEDED'&&result.runId===target.runId&&result.status==='cancelling');
   if(!target.commandId||replace){const next=deps.newCommandId();await write('cancel_dispatch_bind',target,{command_id:next,previous_command_id:target.commandId||null,...(replace?{previous_state:{status:expired?'EXPIRED':command!.status,...(!expired&&command!.status==='SUCCEEDED'?{result_status:'cancelling'}:{})}}:{})});target.commandId=next;command=null;}
   if(command&&command.status!=='CREATED')continue;
   const frame=await deps.createCommand({user:target.legacyOwner,clientId:target.clientId,commandId:target.commandId!,action:'CANCEL_EXPERIMENT_RUN',payload:{kind:'benchmark',runId:target.runId,requestDigest:target.requestDigest}});await deps.dispatch(target.clientId,frame);
  }
  if(current.status==='completed')state.pending.delete(idKey);return current;
 });state.inflight.set(idKey,task);try{return await task;}finally{if(state.inflight.get(idKey)===task)state.inflight.delete(idKey);}
}

export async function readPendingCoreBenchmarkCancellations(context:CoreExperimentContext,limit=20,afterId?:string):Promise<CoreCancellation[]>{
 if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Object.assign(new Error('Pending Benchmark cancellation budget invalid'),{status:400});return runWithCoreExperimentContext(context,async()=>{const rows=await benchmarkCoreRpc<CoreCancellation[]>('cancel_load',{pending:true,limit,...(afterId?{after_id:afterId}:{})});if(!Array.isArray(rows)||rows.some(row=>!row||typeof row.id!=='string'||row.status!=='pending'))throw Object.assign(new Error('Pending Benchmark cancellations unavailable'),{status:502});return rows;});
}
