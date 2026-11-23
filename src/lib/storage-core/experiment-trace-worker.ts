import {newCommandId,createCommand,getCommand} from '@/lib/reliability/command-bus';
import {assertTraceGenerationTarget,dispatchTraceGenerationCommand,cancelTraceGenerationCommand,waitForCommand,findExecutionByTraceId,traceIdFromCompletedCommand,isTraceGenerationFailureRetryable,type TraceGenerationRequest,type TraceGenerationResult,type TraceGenerationOptions,type TriggerDecision,readTriggerDecision,AUTO_RETRY_DELAYS_MS} from '@/lib/engine/experiment/trace-generation';
import {prepareCoreExperimentStart} from './experiment-assets';
import {runWithCoreExperimentContext,type CoreExperimentContext} from './experiments';
import {activateExperimentWork,type ExperimentWorkHandle} from './experiment-worker';
import {submitCoreExecutionReceipt,isCoreDeliveryUncertain} from './execution-delivery';
import {mapConcurrent,parseExecutionConcurrency} from '@/lib/engine/experiment/execution-concurrency';
import {DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS,MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS,TRIGGER_STARTUP_TIMEOUT_SECONDS} from '@/lib/engine/experiment/constants';

type TraceWork={handle:ExperimentWorkHandle;raw_case:{id:string;input:string};execution_request:TraceGenerationRequest;checkpoint:{command_id?:string;cleanup_confirmed?:boolean};cleanup_required?:boolean;cleanup_target?:{kind:'ordinary'|'fi';runId:string;clientId?:string}};
const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export async function runCoreTraceWork(original:ExperimentWorkHandle,context:CoreExperimentContext,parentSignal?:AbortSignal):Promise<{ready:boolean;retryable?:boolean;triggerDecision?:TriggerDecision}> {
 let handle={...original};let request:TraceGenerationRequest|undefined;let commandId:string|undefined;let dispatched=false;let priorCleanupRequired=false;let activeCommandClient:string|undefined;let heartbeat:Promise<void>|undefined;
 const controller=new AbortController();
 const abort=()=>controller.abort(parentSignal?.reason);parentSignal?.addEventListener('abort',abort,{once:true});if(parentSignal?.aborted)abort();
 const renew=()=>heartbeat ||= context.rpc('renew',{...handle,lease_ms:30000}).then(()=>{},error=>{controller.abort(error);}).finally(()=>{heartbeat=undefined;});
 const timer=setInterval(()=>{void renew();},500);timer.unref?.();
 const mutation=async(action:string,value:Record<string,unknown>)=>{
  const payload={...handle,...value,...(action==='checkpoint'?{checkpoint:{...(value.checkpoint as Record<string,unknown>),stage:value.stage}}:{})};const key=`trace:${handle.attempt_id}:${handle.fence}:${action}:${String(value.command_id||value.trace_id||'')}:${String(value.stage||'')}`;return action==='execute_complete'?submitCoreExecutionReceipt(context,handle,value,key,payload):context.rpc(action,{...payload,operation_key:key,operation_request:payload});
 };
 try {
  const work=await context.rpc('load_work',{...handle}) as TraceWork;
  request=work.execution_request;priorCleanupRequired=work.cleanup_required===true;if(!priorCleanupRequired)activeCommandClient=request?.workerId;
  if(!request||!work.raw_case.input?.trim())throw Object.assign(new Error('Frozen execution input is missing'),{code:'EXECUTION_INPUT_MISSING'});
  await assertTraceGenerationTarget({...request,user:context.actor.username});
  controller.signal.throwIfAborted();
  commandId=work.checkpoint?.command_id||newCommandId();
  if(work.cleanup_required){
   const target=work.cleanup_target;if(!target?.runId)throw Object.assign(new Error('Previous cleanup target is unavailable'),{status:503});
   if(target.kind==='fi'){const {cancelFiExecution}=await import('@/lib/engine/experiment/fi-orchestrate');await cancelFiExecution(context.actor.username,target.runId);}
   else{if(!target.clientId)throw Object.assign(new Error('Previous cleanup client is unavailable'),{status:503});await cancelTraceGenerationCommand(context.actor.username,target.clientId,target.runId);}
   const updated=await mutation('checkpoint',{expected_revision:handle.checkpoint_revision,command_id:commandId,stage:'cleanup_confirmed',checkpoint:{...work.checkpoint,cleanup_confirmed:true}}) as ExperimentWorkHandle;
   handle={...handle,...updated};commandId=newCommandId();work.checkpoint={};priorCleanupRequired=false;activeCommandClient=request.workerId;
  }
  if(work.checkpoint.cleanup_confirmed){commandId=newCommandId();work.checkpoint={};}
  const timeoutSeconds=Math.max(MIN_EXPERIMENT_AGENT_TIMEOUT_SECONDS,Math.min(request.timeoutSeconds??DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS,MAX_EXPERIMENT_AGENT_TIMEOUT_SECONDS));
  const startupSeconds=request.skillExecution?.version===2?TRIGGER_STARTUP_TIMEOUT_SECONDS:0;
  const waitMs=(timeoutSeconds+startupSeconds+90)*1000;
  if(!work.checkpoint?.command_id){
   const updated=await mutation('checkpoint',{expected_revision:handle.checkpoint_revision,command_id:commandId,stage:'dispatching',checkpoint:{command_id:commandId,status:'dispatching',platform:request.platform,agent:request.agent,model:request.model,timeoutSeconds}}) as ExperimentWorkHandle;
   handle={...handle,...updated};
  }
  controller.signal.throwIfAborted();await context.rpc('check_work',{...handle});
  const payload={platform:request.platform,agent:request.agent,model:request.model||null,...(request.agentOptions?{agentOptions:request.agentOptions}:{}),input:work.raw_case.input,timeoutSeconds,...(startupSeconds?{startupTimeoutSeconds:startupSeconds}:{}),...(request.skillExecution?{skillExecution:request.skillExecution}:{}),correlation:{experimentId:handle.experiment_id,experimentRunId:handle.run_id,caseRunId:handle.case_id,traceAttemptId:handle.attempt_id,storageCore:true}};
  const frame=await createCommand({user:context.actor.username,clientId:request.workerId,action:'RUN_EXPERIMENT_CASE',commandId,ttlMs:waitMs,payload});
  controller.signal.throwIfAborted();await context.rpc('check_work',{...handle});
  await dispatchTraceGenerationCommand(request.workerId,frame);dispatched=true;
  const command=await waitForCommand(commandId,waitMs,controller.signal);
  controller.signal.throwIfAborted();
  if(command?.status!=='SUCCEEDED')throw Object.assign(new Error(command?.errorMessage||'客户端执行失败'),{code:command?.errorCode||(command?.status==='EXPIRED'?'COMMAND_EXPIRED':'CASE_RUN_FAILED')});
  if(command.clientId!==request.workerId)throw Object.assign(new Error('执行结果客户端不匹配'),{code:'CLIENT_MISMATCH'});
  const traceId=await traceIdFromCompletedCommand(command.resultJson,60000);
  if(!traceId)throw Object.assign(new Error('客户端未返回本次Trace标识'),{code:'TRACE_ID_MISSING'});
  const triggerDecision=request.skillExecution?.version===2?readTriggerDecision(command.resultJson,request.skillExecution.targetSkillName,request.model):undefined;
  const waiting=await mutation('checkpoint',{expected_revision:handle.checkpoint_revision,command_id:commandId,stage:'waiting_trace',checkpoint:{command_id:commandId,observed_trace_id:traceId,status:'waiting_trace',platform:request.platform,agent:request.agent,model:request.model,timeoutSeconds}}) as ExperimentWorkHandle;
  handle={...handle,...waiting};
  const deadline=Date.now()+60000;
  for(;;){
   controller.signal.throwIfAborted();
   const execution=await findExecutionByTraceId({user:context.actor.username,traceId,completedTriggerCommand:command});
   if(!execution){if(Date.now()>=deadline)throw Object.assign(new Error('业务Trace未完成，本次不会自动重新执行Agent'),{code:'TRACE_INGEST_TIMEOUT'});await sleep(1000);continue;}
   try {await mutation('execute_complete',{trace_id:traceId,...(triggerDecision?{trigger_decision:triggerDecision}:{})});break;}
   catch(error){if(isCoreDeliveryUncertain(error)||![404,422,503].includes((error as {status?:number}).status||0))throw error;if(Date.now()>=deadline)throw Object.assign(new Error('Trace入库尚未完成，本次不会自动重新执行Agent'),{code:'TRACE_INGEST_TIMEOUT',status:503});await sleep(1000);}
  }
  return {ready:true,...(triggerDecision?{triggerDecision}:{})};
 }catch(error){
  if(isCoreDeliveryUncertain(error))throw error;
  let failure=error as {code?:string;message?:string};let cleanupConfirmed=!dispatched&&!priorCleanupRequired;
  if(commandId&&request&&activeCommandClient){
   try {const command=await getCommand(commandId);if(dispatched||command){if(command&&(command.clientId!==activeCommandClient||command.user!==context.actor.username))throw Error('Command cleanup target differs');await cancelTraceGenerationCommand(context.actor.username,activeCommandClient,commandId);cleanupConfirmed=true;}}
   catch(cleanup){failure=cleanup as typeof failure;cleanupConfirmed=false;}
  }
  const payload={error:{code:failure?.code||'CASE_RUN_FAILED',message:failure?.message||'Trace generation failed'},cleanup_confirmed:cleanupConfirmed,retryable:cleanupConfirmed&&isTraceGenerationFailureRetryable(failure?.code||'CASE_RUN_FAILED')};
  try {await mutation('execute_fail',payload);}catch(write){if(![409,410].includes((write as {status?:number}).status||0))throw write;}
  return {ready:false,retryable:payload.retryable};
 }finally{parentSignal?.removeEventListener('abort',abort);clearInterval(timer);if(heartbeat)await heartbeat;}
}

export async function prepareCoreTraceRun(context:CoreExperimentContext,request:TraceGenerationRequest,forceNewTrace=false):Promise<string>{
 await assertTraceGenerationTarget({...request,user:context.actor.username});
 const executionRequest={workerId:request.workerId,platform:request.platform,agent:request.agent,model:request.model||null,agentOptions:request.agentOptions,timeoutSeconds:request.timeoutSeconds,executionConcurrency:request.executionConcurrency,skillExecution:request.skillExecution};
 const prepared=await prepareCoreExperimentStart(context,request.experimentId,{caseIds:request.cases.map(item=>item.caseId)});
 const {operation_key:_key,operation_request:_original,...frozen}=prepared.payload;
 const payload={...frozen,experiment_id:request.experimentId,case_ids:request.cases.map(item=>item.caseId),execution_request:executionRequest,force_new_trace:forceNewTrace,...(request.retryFromAttemptId!==undefined?{retry_from_attempt_id:request.retryFromAttemptId}:{})};
 const started=await context.rpc('execute_start',{...payload,operation_key:`${context.operationKey}:execute-start`,operation_request:payload}) as {run_id:string};
 return started.run_id;
}

export async function generateCoreExperimentTraces(context:CoreExperimentContext,request:TraceGenerationRequest,options:TraceGenerationOptions={}):Promise<TraceGenerationResult>{
 const reserved=Object.values(options.reservedAttemptIds||{});
 if(new Set(reserved).size>1)throw Object.assign(new Error('Reserved execution run identity mismatch'),{status:409});
 const runId=reserved[0]||await prepareCoreTraceRun(context,request,options.forceNewTrace);
 const readyCaseIds:string[]=[];const failedCaseIds:string[]=[];const triggerDecisions:Record<string,TriggerDecision>={};
 await runWithCoreExperimentContext(context,()=>mapConcurrent(request.cases,parseExecutionConcurrency(request.executionConcurrency),async item=>{
  for(let round=0;round<=AUTO_RETRY_DELAYS_MS.length;round++){
   request.signal?.throwIfAborted();
   if(round>0)await sleep(AUTO_RETRY_DELAYS_MS[round-1]);
   const handle=await context.rpc('claim',{phase:'execute',experiment_id:request.experimentId,run_id:runId,case_id:item.caseId,worker_id:`trace:${newCommandId()}`,lease_ms:30000}) as ExperimentWorkHandle|null;
   if(!handle){failedCaseIds.push(item.caseId);return;}
   if(request.onAttemptCreated){
    if(typeof handle.attempt_no!=='number')throw Object.assign(new Error('Execution attempt counter is missing'),{status:503});
    let accepted:boolean|void;
    try {accepted=await request.onAttemptCreated({caseId:item.caseId,attemptId:handle.attempt_id,attemptNo:handle.attempt_no});}
    catch(error){
     const payload={...handle,error:{code:'EXECUTION_SUPERSEDED',message:'执行回调未确认当前执行'},cleanup_confirmed:true,retryable:false};
     await context.rpc('execute_fail',{...payload,operation_key:`trace:${handle.attempt_id}:callback-failed`,operation_request:payload});throw error;
    }
    if(accepted===false){
     const payload={...handle,error:{code:'EXECUTION_SUPERSEDED',message:'该执行已被新的重试替换'},cleanup_confirmed:true,retryable:false};
     await context.rpc('execute_fail',{...payload,operation_key:`trace:${handle.attempt_id}:superseded`,operation_request:payload});failedCaseIds.push(item.caseId);return;
    }
   }
   const outcome=await runCoreTraceWork(handle,context,request.signal);
   if(outcome.ready){readyCaseIds.push(item.caseId);if(outcome.triggerDecision)triggerDecisions[item.caseId]=outcome.triggerDecision;return;}
   if(!outcome.retryable||round===AUTO_RETRY_DELAYS_MS.length){failedCaseIds.push(item.caseId);return;}
  }
 }));
 if(readyCaseIds.length)await activateExperimentWork(context,request.experimentId);
 return {readyCaseIds,failedCaseIds,...(request.skillExecution?.version===2?{triggerDecisions}:{})};
}
