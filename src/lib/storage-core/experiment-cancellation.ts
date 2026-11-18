import {createHash} from 'node:crypto';
import type {CoreExperimentContext} from './experiments';
export interface CoreCancellation {id:string;experimentId:string;caseKey:string;revision:string;status:string;error?:string|null;targetsJson:string;updatedAt?:string;historical_inert?:boolean}
type Target={kind:'ordinary'|'fi'|'local';runId:string;clientId?:string;commandId?:string;confirmed?:boolean;error?:string;fiTaskKey?:string};
interface Dependencies {
 getCommand:(id:string)=>Promise<Record<string,unknown>|null>;
 newCommandId:()=>string;
 createCommand:(input:{user:string;clientId:string;commandId:string;action:'CANCEL_EXPERIMENT_RUN';payload:Record<string,unknown>})=>Promise<{commandId:string}>;
 dispatch:(client:string,frame:{commandId:string})=>Promise<void>;
 stopFi:(user:string,runId:string)=>Promise<void>;
 stopLocal?:(context:CoreExperimentContext,attemptId:string)=>Promise<void>;
}
type LocalStop=(context:CoreExperimentContext,attemptId:string)=>Promise<void>;
const localStopKey=Symbol.for('agent-insight.storage-core.local-execution-stop');
const localStops=globalThis as unknown as Record<symbol,LocalStop|undefined>;
export function registerCoreLocalExecutionStop(handler:LocalStop):void{localStops[localStopKey]=handler;}
async function stopLocal(context:CoreExperimentContext,attemptId:string){const handler=localStops[localStopKey];if(!handler)throw Object.assign(new Error('Local execution cleanup is not confirmed on this instance'),{status:503});await handler(context,attemptId);}
async function dependencies():Promise<Dependencies>{
 const bus=await import('@/lib/reliability/command-bus');const transport=await import('@/lib/engine/experiment/trace-generation');const fi=await import('@/lib/engine/experiment/fi-orchestrate');
 return {getCommand:async id=>(await bus.getCommand(id)) as unknown as Record<string,unknown>|null,newCommandId:bus.newCommandId,createCommand:bus.createCommand,dispatch:async(client,frame)=>transport.dispatchTraceGenerationCommand(client,frame as Awaited<ReturnType<typeof bus.createCommand>>),stopFi:fi.cancelFiExecution,stopLocal};
}
function parse(value:unknown):Record<string,unknown>{try{const result=JSON.parse(String(value||'{}'));return result&&typeof result==='object'&&!Array.isArray(result)?result:{};}catch{return {};}}
function sameCommand(row:Record<string,unknown>,target:Target,user:string){const payload=parse(row.payloadJson);return row.user===user&&row.clientId===target.clientId&&row.commandId===target.commandId&&row.action==='CANCEL_EXPERIMENT_RUN'&&payload.kind==='ordinary'&&payload.runId===target.runId;}
const reconciling=new Map<string,Promise<CoreCancellation>>();
export async function coreCancellationKind(context:CoreExperimentContext,payload:Record<string,unknown>):Promise<'ordinary'|'benchmark'>{
 const result=await context.rpc('cancellation_route',payload) as {kind?:string};
 if(result?.kind!=='ordinary'&&result?.kind!=='benchmark')throw Object.assign(new Error('Cancellation domain metadata is unavailable'),{status:503});
 return result.kind;
}
export async function reconcileCoreCancellation(context:CoreExperimentContext,id:string,injected?:Dependencies):Promise<CoreCancellation>{
 const key=context.actor.workspace+':'+context.actor.principal+':'+id;const previous=reconciling.get(key);if(previous)return previous;
 const work=(async()=>{
  if(!injected&&await coreCancellationKind(context,{cancellation_id:id})==='benchmark'){
   const {reconcileCoreBenchmarkCancellation}=await import('@/lib/benchmark/core-cancellation');const current=await reconcileCoreBenchmarkCancellation(context,id);
   if(!current)throw Object.assign(new Error('Benchmark cancellation identity changed'),{status:503});return current;
  }
  let current=await context.rpc('cancellation_lookup',{cancellation_id:id}) as CoreCancellation;if(current.historical_inert===true||current.status==='completed')return current;
  const targets=JSON.parse(current.targetsJson) as Target[];if(!Array.isArray(targets)||targets.length>100000)throw Object.assign(new Error('Invalid cancellation targets'),{status:503});
  const deps=injected||await dependencies();const user=context.actor.username;
  const persist=async()=>{
   const payload={experiment_id:current.experimentId,cancellation_id:id,expected_revision:current.revision,targets,status:targets.every(target=>target.confirmed===true)?'completed':'pending',error:targets.filter(target=>target.error).map(target=>target.error).join('; ')||null};
   const digest=createHash('sha256').update(JSON.stringify(payload)).digest('hex');
   current=await context.rpc('cancellation_update',{...payload,operation_key:`cancel:${id}:${current.revision}:${digest}`,operation_request:payload}) as CoreCancellation;return current;
  };
  let changed=false;
  for(const target of targets){
   if(target.confirmed)continue;
   try{
    if(target.kind==='local'){if(!deps.stopLocal)throw Object.assign(new Error('Local cleanup verifier unavailable'),{status:503});await deps.stopLocal(context,target.runId);target.confirmed=true;delete target.error;changed=true;continue;}
    if(target.kind==='fi'){await deps.stopFi(user,target.runId);target.confirmed=true;delete target.error;changed=true;continue;}
    if(target.kind!=='ordinary'||!target.clientId)throw Error('停止目标缺少真实客户端标识');
    const row=target.commandId?await deps.getCommand(target.commandId):null;
    if(row&&!sameCommand(row,target,user))throw Error('停止回执与当前执行目标不匹配');
    if(row?.status==='SUCCEEDED'){
     const facts=parse(row.resultJson);const result=facts.result&&typeof facts.result==='object'?facts.result as Record<string,unknown>:facts;
     if(result.runId===target.runId&&result.status==='cancelled'){target.confirmed=true;delete target.error;changed=true;continue;}
     target.error='执行进程退出尚未确认，平台将继续核查';changed=true;
    }
    const expired=row&&new Date(String(row.expiresAt)).getTime()<=Date.now();
    if(!row||expired||['FAILED','EXPIRED','DELIVERY_FAILED'].includes(String(row.status))){
     target.commandId=deps.newCommandId();const frame=await deps.createCommand({user,clientId:target.clientId,commandId:target.commandId,action:'CANCEL_EXPERIMENT_RUN',payload:{kind:'ordinary',runId:target.runId}});
     delete target.error;await persist();changed=false;await deps.dispatch(target.clientId,frame);
    }else if(row.status==='CREATED'){
     const frame=await deps.createCommand({user,clientId:target.clientId,commandId:target.commandId!,action:'CANCEL_EXPERIMENT_RUN',payload:{kind:'ordinary',runId:target.runId}});await deps.dispatch(target.clientId,frame);
    }
   }catch(error){if([401,403,409].includes((error as {status?:number}).status||0))throw error;target.error='客户端停止尚未确认';changed=true;}
  }
  return changed?persist():current;
 })();reconciling.set(key,work);try{return await work;}finally{if(reconciling.get(key)===work)reconciling.delete(key);}
}
export async function cancelCoreExperimentExecution(context:CoreExperimentContext,experimentId:string,options:{caseId?:string;deleteExperiment?:boolean;draftOnly?:boolean}={}):Promise<CoreCancellation>{
 const action=options.deleteExperiment?'remove':options.caseId?'case_remove':'cancel';
 if(await coreCancellationKind(context,{experiment_id:experimentId,mode:action})==='benchmark'){
  const {maybeCancelCoreBenchmarkExecution}=await import('@/lib/benchmark/core-cancellation');const current=await maybeCancelCoreBenchmarkExecution(context,experimentId,options);
  if(!current)throw Object.assign(new Error('Benchmark cancellation identity changed'),{status:503});return current;
 }
 const result=await context.rpc(action,{experiment_id:experimentId,...(options.caseId?{case_id:options.caseId}:{}),...(options.draftOnly?{draft_only:true}:{})}) as {cancellation:CoreCancellation};
 if(!result?.cancellation?.id)throw Object.assign(new Error('Cancellation receipt required'),{status:503});
 if(result.cancellation.status!=='completed'){
  registerCoreCancellationContext(context);
  void reconcileCoreCancellation(context,result.cancellation.id).catch(()=>{});
 }
 return result.cancellation;
}
const actors=new Map<string,CoreExperimentContext>();let timer:ReturnType<typeof setInterval>|undefined;let sweeping=false;
export function registerCoreCancellationContext(context:CoreExperimentContext){
 const key=context.actor.workspace+':'+context.actor.principal;if(!actors.has(key)&&actors.size>=1000)throw Object.assign(new Error('Cancellation actor budget exceeded'),{status:429});actors.set(key,context);
 if(timer)return;timer=setInterval(()=>{void sweepCoreCancellations();},3000);timer.unref();
}
export async function sweepCoreCancellations(){
 if(sweeping)return;sweeping=true;
 try{for(const [key,context] of actors){try{const rows=await context.rpc('cancellations',{limit:100,owned_only:true,oldest_first:true}) as CoreCancellation[];if(!rows.length){actors.delete(key);continue;}for(const row of rows)await reconcileCoreCancellation(context,row.id);}catch(error){if([401,403].includes((error as {status?:number}).status||0))actors.delete(key);}}}finally{sweeping=false;}
}
