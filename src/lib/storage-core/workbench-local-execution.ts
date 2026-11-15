import {createHash,randomUUID} from 'node:crypto';
import {prepareCoreExperimentStart} from './experiment-assets';
import {prepareCoreExperimentRuntime,runWithCoreExperimentContext,type CoreExperimentContext} from './experiments';
import type {ExperimentWorkHandle} from './experiment-worker';
import {sweepCoreCancellations,registerCoreLocalExecutionStop} from './experiment-cancellation';
import {submitCoreExecutionReceipt,isCoreDeliveryUncertain} from './execution-delivery';
import {withExperimentDatasetCaseBinding} from '@/lib/engine/experiment/dataset-case-binding';

type Row=Record<string,unknown>;
interface LocalInput {
 user:string;experimentId:string;experimentCaseId?:string;datasetId:string;datasetCaseId:string;query:string;referenceOutput?:string|null;signal:AbortSignal;
 executionRequest?:Row;skillRun?:Row;onCaseCreated:(id:string)=>Promise<void>;onAttemptCreated?:(attempt:{caseId:string;attemptId:string;attemptNo:number})=>Promise<boolean|void>;
}
interface LocalEntry {controller:AbortController;completion:Promise<void>;clean:boolean;finished:boolean}
const registryKey=Symbol.for('agent-insight.core-workbench-local-executions');
const localGlobals=globalThis as unknown as Record<symbol,Map<string,LocalEntry>>;
const entries=localGlobals[registryKey] ||=new Map<string,LocalEntry>();
const key=(context:CoreExperimentContext,attempt:string)=>JSON.stringify([context.actor.workspace,context.actor.principal,attempt]);
const unavailable=(message:string)=>Object.assign(new Error(message),{status:503});
export async function stopCoreLocalExecution(context:CoreExperimentContext,attemptId:string):Promise<void>{
 const entry=entries.get(key(context,attemptId));if(!entry)throw unavailable('本机执行停止尚无进程退出证明');
 entry.controller.abort(Object.assign(new Error('Experiment cancelled'),{code:'EXPERIMENT_CANCELLED'}));
 await entry.completion;if(!entry.clean)throw unavailable('本机 Agent 进程退出尚未确认');
}
export async function executeCoreWorkbenchLocalCase<T extends {sessionId:string}>(context:CoreExperimentContext,input:LocalInput,execute:(signal:AbortSignal)=>Promise<T>):Promise<T>{
 if(input.user!==context.actor.username)throw Object.assign(new Error('Workbench actor differs'),{status:403});input.signal.throwIfAborted();
 registerCoreLocalExecutionStop(stopCoreLocalExecution);
 const snapshot=await context.rpc('read',{experiment_id:input.experimentId}) as {gold_redacted?:boolean;experiment:{cases:Row[]}};
 if(snapshot.gold_redacted)throw Object.assign(new Error('Task-linked Experiment belongs to another actor'),{status:403});
 const previous=input.experimentCaseId?snapshot.experiment.cases.find(row=>row.id===input.experimentCaseId):undefined;
 if(input.experimentCaseId&&!previous)throw Object.assign(new Error('实验 Case 已不存在'),{status:404});
 const caseId=input.experimentCaseId||'workbench-local-'+createHash('sha256').update(JSON.stringify([context.actor.workspace,context.actor.principal,input.experimentId,input.datasetId,input.datasetCaseId,input.skillRun||context.operationKey])).digest('hex').slice(0,40);
 const values=JSON.parse(String(previous?.caseValuesJson||'{}'));
 const payload={experiment_id:input.experimentId,case:{id:caseId,...(!previous?{input:input.query,datasetInput:input.query,actualOutput:'',referenceOutput:input.referenceOutput??null}:{}),caseValuesJson:JSON.stringify(withExperimentDatasetCaseBinding(values,{datasetId:input.datasetId,caseId:input.datasetCaseId}))}};
 const saved=await context.rpc('case_upsert',{...payload,operation_key:context.operationKey+':local-case:'+caseId,operation_request:payload}) as {case_id:string};
 if(saved.case_id!==caseId)throw unavailable('Local Case receipt differs');await input.onCaseCreated(caseId);
 const prepared=await prepareCoreExperimentStart(context,input.experimentId,{caseIds:[caseId]});const {operation_key:_key,operation_request:_request,...frozen}=prepared.payload;
 const request={...frozen,experiment_id:input.experimentId,case_ids:[caseId],execution_request:{...input.executionRequest,kind:'local'},force_new_trace:true};
 const start=await context.rpc('execute_start',{...request,operation_key:context.operationKey+':local-start:'+caseId,operation_request:request}) as {run_id:string};
 let handle=await context.rpc('claim',{phase:'execute',experiment_id:input.experimentId,run_id:start.run_id,case_id:caseId,worker_id:'local:'+randomUUID(),lease_ms:30000}) as ExperimentWorkHandle|null;
 if(!handle)throw unavailable('Local execution is already owned');
 const controller=new AbortController();const abort=()=>controller.abort(input.signal.reason);input.signal.addEventListener('abort',abort,{once:true});if(input.signal.aborted)abort();
 let resolve!:()=>void;const entry:LocalEntry={controller,completion:new Promise<void>(yes=>{resolve=yes;}),clean:false,finished:false};
 if(entries.size>=1000){for(const [identity,old] of entries){if(old.finished)entries.delete(identity);if(entries.size<1000)break;}}
 if(entries.size>=1000)throw unavailable('Local execution registry is full');entries.set(key(context,handle.attempt_id),entry);
 let heartbeat:Promise<void>|undefined;const renew=()=>heartbeat ||=context.rpc('renew',{...handle,lease_ms:30000}).then(()=>{},error=>controller.abort(error)).finally(()=>{heartbeat=undefined;});
 const timer=setInterval(()=>{void renew();},500);timer.unref?.();
 const mutate=async(action:string,value:Row)=>{const body={...handle,...value,...(action==='checkpoint'?{checkpoint:{...(value.checkpoint as Row),stage:value.stage}}:{})};return context.rpc(action,{...body,operation_key:`local:${handle!.attempt_id}:${handle!.fence}:${action}:${String(value.stage||'')}`,operation_request:body});};
 let observed:T|undefined;
 try{
  const work=await context.rpc('load_work',{...handle}) as {handle:ExperimentWorkHandle;execution_request:{kind?:string};checkpoint:Row;cleanup_required?:boolean;cleanup_target?:{kind:string;runId:string};runplan?:Row};
  if(work.execution_request.kind!=='local')throw unavailable('Sealed execution is not local');
  if(work.cleanup_required){if(work.cleanup_target?.kind!=='local')throw unavailable('Previous local cleanup target differs');await stopCoreLocalExecution(context,work.cleanup_target.runId);throw unavailable('Previous local cleanup requires fenced recovery before execution');}
  const plan=await context.rpc('runplan',{experiment_id:input.experimentId,run_id:handle.run_id}) as {runplan:Row};work.runplan=plan.runplan;
  if(input.onAttemptCreated&&await input.onAttemptCreated({caseId,attemptId:handle.attempt_id,attemptNo:handle.attempt_no as number})===false)throw Object.assign(new Error('Execution superseded'),{code:'EXECUTION_SUPERSEDED'});
  handle={...handle,...await mutate('checkpoint',{expected_revision:handle.checkpoint_revision,command_id:'local:'+handle.attempt_id,stage:'running',checkpoint:{command_id:'local:'+handle.attempt_id,status:'running'}}) as ExperimentWorkHandle};
  controller.signal.throwIfAborted();await context.rpc('check_work',{...handle});
  let result:T;
  try{result=await runWithCoreExperimentContext(context,()=>prepareCoreExperimentRuntime(context,work,()=>execute(controller.signal),{signal:controller.signal,publicExecution:true}));entry.clean=true;observed=result;}
  catch(error){entry.clean=(error as {code?:string}).code!=='EVALUATION_CLEANUP_UNCONFIRMED';throw error;}
  controller.signal.throwIfAborted();await renew();controller.signal.throwIfAborted();
  handle={...handle,...await mutate('checkpoint',{expected_revision:handle.checkpoint_revision,command_id:'local:'+handle.attempt_id,stage:'waiting_trace',checkpoint:{command_id:'local:'+handle.attempt_id,status:'waiting_trace',observed_trace_id:result.sessionId}}) as ExperimentWorkHandle};
  try{await submitCoreExecutionReceipt(context,handle,{trace_id:result.sessionId},`local:${handle.attempt_id}:${handle.fence}:execute_complete`);}
  catch(error){if(isCoreDeliveryUncertain(error))throw Object.assign(error as object,{coreLocalExecutionResult:result});throw error;}
  return result;
 }catch(error){
  if(observed)throw Object.assign(error&&typeof error==='object'?error:new Error('Execution delivery is pending'),{status:503,coreDeliveryUncertain:true,coreLocalExecutionResult:observed});
  if(isCoreDeliveryUncertain(error))throw error;
  const failure=error as {code?:string;message?:string};
  try{await mutate('execute_fail',{error:{code:failure.code||'CASE_RUN_FAILED',message:failure.message||'Local Agent failed'},cleanup_confirmed:entry.clean,retryable:false});}catch(cause){if(![401,403,409,410].includes((cause as {status?:number}).status||0))throw cause;}
  throw error;
 }finally{clearInterval(timer);input.signal.removeEventListener('abort',abort);if(heartbeat)await heartbeat;entry.finished=true;resolve();void sweepCoreCancellations().catch(()=>{});}
}
