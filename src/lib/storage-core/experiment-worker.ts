import {randomUUID} from 'node:crypto';
import {evaluateFrozenExperimentWork} from '@/lib/engine/experiment/run-experiment';
import {prepareCoreExperimentRuntime,runWithCoreExperimentContext,type CoreExperimentContext} from './experiments';
import {isCoreDeliveryUncertain,submitCoreOperationReceipt} from './execution-delivery';
import {attachExperimentSkillDerived} from './experiment-skill-derived';

export interface ExperimentWorkHandle extends Record<string,unknown> {
 experiment_id:string;run_id:string;work_item_id:string;attempt_id:string;case_id:string;result_id:string;evaluator_id:string;fence:string;lease_owner:string;lease_until_ms:number;
}
export interface FrozenExperimentWork {
 handle:ExperimentWorkHandle;raw_case:Record<string,unknown>;experiment_config:Record<string,unknown>;
 frozen_trace_evidence:{execution:Record<string,unknown>|null;session?:{interactions:unknown}|null;execution_skills?:unknown[];[key:string]:unknown}|null;
 frozen_evaluator:{card:unknown;[key:string]:unknown};runplan:Record<string,unknown>;frozen_ras_events?:unknown[];
}
interface Activation {concurrency:number;context:CoreExperimentContext;generation:number;completion:Promise<void>}
const active=new Map<string,Activation>();
const scopeKey=(context:CoreExperimentContext,experimentId:string)=>`${context.actor.workspace}:${context.actor.principal}:${experimentId}`;
export interface CoreEvaluationTarget {experiment_id:string;attempt_id:string;work_item_id:string;run_id:string;fence:string;lease_owner:string;actor_principal_id:string}
interface EvaluationEntry {target:CoreEvaluationTarget;workspace:string;controller?:AbortController;state:'running'|'confirmed'|'unconfirmed';unconfirmed:boolean;done:Promise<void>;finish:()=>void}
const evaluationKey=Symbol.for('agent-insight.storage-core.native-evaluation-attempts');
const evaluationGlobals=globalThis as unknown as Record<symbol,Map<string,EvaluationEntry>>;
const evaluations=evaluationGlobals[evaluationKey] ||= new Map<string,EvaluationEntry>();
const evaluationIdentity=(workspace:string,principal:string,attempt:string)=>JSON.stringify([workspace,principal,attempt]);
function registerEvaluation(context:CoreExperimentContext,handle:ExperimentWorkHandle,controller:AbortController):EvaluationEntry{
 const workspace=context.actor.workspace||'',principal=context.actor.principal||'',key=evaluationIdentity(workspace,principal,handle.attempt_id);
 if(evaluations.has(key))throw Object.assign(new Error('This physical evaluation attempt is already observed'),{status:503,coreDeliveryUncertain:true});
 if(evaluations.size>=10000){for(const [id,value] of evaluations){if(value.state==='confirmed')evaluations.delete(id);if(evaluations.size<9000)break;}}
 if(evaluations.size>=10000)throw Object.assign(new Error('Native evaluation tracking budget is full'),{status:429});
 let finish!:()=>void;const done=new Promise<void>(resolve=>{finish=resolve;});
 const target=Object.freeze({experiment_id:handle.experiment_id,attempt_id:handle.attempt_id,work_item_id:handle.work_item_id,run_id:handle.run_id,fence:String(handle.fence),lease_owner:handle.lease_owner,actor_principal_id:principal});
 const entry:EvaluationEntry={target,workspace,controller,state:'running',unconfirmed:false,done,finish};evaluations.set(key,entry);return entry;
}
export async function stopCoreEvaluationAttempt(context:CoreExperimentContext,target:CoreEvaluationTarget):Promise<CoreEvaluationTarget&{transport:'native-worker';workspace_id:string;cleanup:'confirmed'}>{
 const entry=evaluations.get(evaluationIdentity(context.actor.workspace,target.actor_principal_id,target.attempt_id));
 if(!entry)throw Object.assign(new Error('Native evaluation cleanup is not known on this instance'),{status:503});
 if(Object.keys(entry.target).some(key=>entry.target[key as keyof CoreEvaluationTarget]!==target[key as keyof CoreEvaluationTarget]))throw Object.assign(new Error('Native evaluation cleanup identity differs'),{status:409});
 entry.controller?.abort(Object.assign(new Error('Evaluation cancelled'),{status:409,code:'EXPERIMENT_CANCELLED'}));
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{await Promise.race([entry.done,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Native evaluation is still stopping'),{status:503})),10000);})]);}finally{if(timer)clearTimeout(timer);}
 if(entry.state!=='confirmed')throw Object.assign(new Error('Native evaluation process cleanup is unconfirmed'),{status:503});
 return {...entry.target,transport:'native-worker',workspace_id:entry.workspace,cleanup:'confirmed'};
}

export async function runCoreExperimentWork(handle:ExperimentWorkHandle,context:CoreExperimentContext):Promise<'done'|'failed'> {
 const controller=new AbortController();const observed=registerEvaluation(context,handle,controller);let submitting=false;
 let checking:Promise<void>|undefined;
 const check=()=>checking ||= context.rpc('renew',{...handle,lease_ms:30000}).then(()=>{},error=>{controller.abort(error);}).finally(()=>{checking=undefined;});
 const timer=setInterval(()=>{void check();},500);
 timer.unref?.();
 try {
  const work=await context.rpc('load_work',{...handle}) as FrozenExperimentWork;
  const config=work.runplan?.config as {frozen_ras_events?:Record<string,unknown[]>}|undefined;
  if (!work.frozen_ras_events && config?.frozen_ras_events) work.frozen_ras_events=config.frozen_ras_events[handle.case_id];
  const evaluated=await runWithCoreExperimentContext(context,()=>prepareCoreExperimentRuntime(context,work,()=>evaluateFrozenExperimentWork(work,{user:context.actor.username,signal:controller.signal}),{signal:controller.signal}));
  const result=attachExperimentSkillDerived(work,evaluated);
  controller.signal.throwIfAborted();
  await check();controller.signal.throwIfAborted();
  const payload={...handle,result};
  submitting=true;
  await submitCoreOperationReceipt(context,'complete',payload,`experiment:${handle.attempt_id}:${handle.fence}:complete`);
  return 'done';
 } catch(error) {
  if((error as {code?:string})?.code==='EVALUATION_CLEANUP_UNCONFIRMED')observed.unconfirmed=true;
  if(isCoreDeliveryUncertain(error))throw error;
  const deliveryStatus=(error as {status?:number})?.status;
  if(submitting&&![400,413,422].includes(deliveryStatus||0)){
   throw error;
  }
  if (controller.signal.aborted) return 'failed';
  const failure=error as {message?:string;code?:string;coreExperimentFailureResult?:Record<string,unknown>};
  const payload={...handle,...(failure.coreExperimentFailureResult?{result:failure.coreExperimentFailureResult}:{}),error:{message:failure?.message||'Experiment scoring failed',...(failure?.code?{code:failure.code}:{})}};
  try {await context.rpc('fail',{...payload,operation_key:`experiment:${handle.attempt_id}:${handle.fence}:fail`,operation_request:payload});}
  catch(cause){if(![409,410].includes((cause as {status?:number})?.status||0))throw cause;}
  return 'failed';
 } finally {clearInterval(timer);try{if(checking)await checking;}finally{observed.state=observed.unconfirmed?'unconfirmed':'confirmed';observed.controller=undefined;observed.finish();}}
}

export function activateExperimentWork(context:CoreExperimentContext,experimentId:string,options:{concurrency?:number}={}):Promise<void> {
 const concurrency=options.concurrency??4;if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>1024)throw Object.assign(new Error('Invalid Experiment scoring concurrency'),{status:400});
 const key=scopeKey(context,experimentId);const previous=active.get(key);
 if(previous){if(options.concurrency!==undefined)previous.concurrency=concurrency;previous.context=context;previous.generation++;return previous.completion;}
 let resolve!:()=>void;let reject!:(cause:unknown)=>void;
 const entry:Activation={concurrency,context,generation:1,completion:new Promise<void>((yes,no)=>{resolve=yes;reject=no;})};active.set(key,entry);
 const drain=async()=>{
  const workerId=randomUUID();
  try{
   for(;;){
    const quiet=await Promise.all(Array.from({length:entry.concurrency},async()=>{
     for(;;){
      const generation=entry.generation;const actorContext=entry.context;let handle:ExperimentWorkHandle|null;
      try{handle=await actorContext.rpc('claim',{phase:'evaluate',experiment_id:experimentId,worker_id:workerId,lease_ms:30000}) as ExperimentWorkHandle|null;}
      catch(cause){if(actorContext!==entry.context)continue;throw cause;}
      if(!handle)return generation;await runCoreExperimentWork(handle,actorContext);
     }
    }));
    const actorContext=entry.context;
    try{await actorContext.rpc('reconcile',{experiment_id:experimentId});}catch(cause){if(actorContext!==entry.context)continue;throw cause;}
    if(quiet.every(generation=>generation===entry.generation))return;
   }
  }finally{if(active.get(key)===entry)active.delete(key);}
 };
 void drain().then(resolve,reject);return entry.completion;
}

export async function executeCoreResultRow(context:CoreExperimentContext,resultId:string,experimentId?:string):Promise<'done'|'failed'> {
 if(!experimentId){
  const result=await context.rpc('result_lookup',{result_id:resultId}) as {experiment_id:string};
  experimentId=result.experiment_id;
 }
 if(!experimentId)throw Object.assign(new Error('Experiment result identity is unavailable'),{status:404});
 const handle=await context.rpc('claim',{phase:'evaluate',experiment_id:experimentId,result_id:resultId,worker_id:randomUUID(),lease_ms:30000}) as ExperimentWorkHandle|null;
 if(!handle){
  const deadline=Date.now()+300000;
  while(true){
   context.cancelSignal?.throwIfAborted();
   const current=await context.rpc('result_lookup',{result_id:resultId}) as {experiment_id:string;status:string};
   if(current.experiment_id!==experimentId)throw Object.assign(new Error('Experiment result scope changed'),{status:409});
   if(current.status==='done')return 'done';if(['failed','cancelled'].includes(current.status))return 'failed';
   if(!['pending','running'].includes(current.status)||Date.now()>=deadline)throw Object.assign(new Error('Experiment result is still owned by another worker'),{status:503});
   await new Promise(resolve=>setTimeout(resolve,250));
  }
 }
 const status=await runCoreExperimentWork(handle,context);
 await context.rpc('reconcile',{experiment_id:experimentId});return status;
}
