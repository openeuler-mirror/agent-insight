import {createHash} from 'node:crypto';
import {requireCoreExperimentContext} from '@/lib/storage-core/experiments';
import {benchmarkCoreRpc} from './core-store';
import {prepareCoreBenchmarkEvaluation,dispatchCoreBenchmarkEvaluationForOwner,dispatchCoreBenchmarkExecutionForOwner} from './core-runtime';

export async function retryCoreBenchmarkEvaluation(input:{experimentId:string;resultId:string;user:string}):Promise<{status:'running';evaluationRunId:string}>{
 const context=requireCoreExperimentContext();if(input.user!==context.actor.username)throw Object.assign(new Error('Benchmark retry actor differs'),{status:403});const request={experiment_id:input.experimentId,result_id:input.resultId};const key=context.operationKey+':benchmark-evaluation-retry';const old=await benchmarkCoreRpc<{evaluationRunId:string}|null>('lookup_operation',{kind:'retry_evaluation',operation_key:key,operation_request:request});
 if(old){await dispatchCoreBenchmarkEvaluationForOwner(old.evaluationRunId);return {status:'running',evaluationRunId:old.evaluationRunId};}
 const prepared=await benchmarkCoreRpc<{work:Parameters<typeof prepareCoreBenchmarkEvaluation>[0];previous_job_id:string;expected_machine_result_id:string;dispatch_target:{baseUrl:string;evaluatorKey:string}|null}>('prepare_evaluation_retry',request);
 if(!prepared.dispatch_target)throw Object.assign(new Error('Frozen Benchmark evaluator target unavailable'),{status:503});const id='veval_'+createHash('sha256').update(JSON.stringify([context.actor.workspace,context.actor.principal,key,prepared.previous_job_id,'evaluation-retry/v1'])).digest('hex').slice(0,32);const dispatch=await prepareCoreBenchmarkEvaluation(prepared.work,prepared.work.handle.job_id,{evaluationId:id,dispatchTarget:prepared.dispatch_target});const result=await benchmarkCoreRpc<{evaluationRunId:string}>('retry_evaluation',{...request,previous_job_id:prepared.previous_job_id,expected_machine_result_id:prepared.expected_machine_result_id,request:dispatch,operation_key:key,operation_request:request});await dispatchCoreBenchmarkEvaluationForOwner(result.evaluationRunId);return {status:'running',evaluationRunId:result.evaluationRunId};
}

export async function retryCoreBenchmarkCase(input:{experimentId:string;caseId:string;user:string}):Promise<{status:'running';alreadyRunning:boolean;runId:string;runplanId:string;completion:Promise<void>}>{
 const context=requireCoreExperimentContext();if(input.user!==context.actor.username)throw Object.assign(new Error('Benchmark retry actor differs'),{status:403});
 const request={experiment_id:input.experimentId,case_id:input.caseId};const key=context.operationKey+':benchmark-case-retry';
 type Started={status:'running';alreadyRunning:boolean;runId:string;runplanId:string};
 const old=await benchmarkCoreRpc<Started|null>('lookup_operation',{kind:'retry_case',operation_key:key,operation_request:request});
 let result=old;
 if(!result){
  const prepared=await benchmarkCoreRpc<{previous_job_id:string;expected_machine_result_id:string|null}>('prepare_case_retry',request);
  result=await benchmarkCoreRpc<Started>('retry_case',{...request,...prepared,operation_key:key,operation_request:request});
 }
 return {...result,completion:dispatchCoreBenchmarkExecutionForOwner(result.runId)};
}
