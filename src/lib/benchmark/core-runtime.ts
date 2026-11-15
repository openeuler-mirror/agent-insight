import {createHash,randomUUID} from 'node:crypto';
import {benchmarkCoreRpc,benchmarkCallbackRpc,type BenchmarkCallbackContext} from './core-store';
import {getBenchmarkAdapter} from './adapter-registry';
import {defaultEvaluatorTargetResolver} from './evaluator-target';
import {benchmarkEvaluationDispatchDigest,type ArtifactDescriptor,type BenchmarkEvaluationDispatchRequest,type EvaluationJob} from '../../../packages/benchmark-protocol/src/evaluation-contracts';
import {fingerprintJson,type AgentTaskEnvelope,type BenchmarkRunConfig,type JsonValue} from '../../../packages/benchmark-protocol/src/contracts';
import type {BenchmarkEvaluationCompletion,NormalizedBenchmarkResult} from '../../../packages/benchmark-protocol/src/evaluator-contracts';
import {evidenceSource,matchesEvidenceCollection} from '../../../packages/benchmark-protocol/artifact-path.cjs';

interface StoredArtifact {artifactId:string;sha256:`sha256:${string}`;size:number;name:string;kind:string;media_type:string;bytes_base64:string}
interface CoreBenchmarkWork {
 actor_username:string;handle:{job_id:string;case_id:string;experiment_id:string;[key:string]:unknown};job:{job_id:string;adapter_key:string;evaluator_key?:string;protocol_state:string};
 binding:{dataset_content_hash:string;adapter:Record<string,unknown>;run_config:BenchmarkRunConfig&{legacyOwner?:string;submissionSource?:string}};case:{dataset_case:{publicPayload:JsonValue;privatePayload:JsonValue;rawCase:unknown}};
 runplan:{config:{public_callback_origin:string;executor_callback_origin:string}};request:({task:AgentTaskEnvelope}|{evaluationJob:EvaluationJob})&Record<string,unknown>;artifacts:StoredArtifact[];completion:BenchmarkEvaluationCompletion;completion_hash:string;
}
function frozenAdapter(work:CoreBenchmarkWork){
 const adapter=getBenchmarkAdapter(work.job.adapter_key);const expected={...work.binding.adapter};delete expected.key;delete expected.evaluatorId;
 if(fingerprintJson(expected as JsonValue)!==fingerprintJson(adapter.manifest as unknown as JsonValue))throw Object.assign(new Error('Benchmark adapter definition differs from the frozen binding'),{status:409});return adapter;
}
function status(error:unknown):number|undefined{return error&&typeof error==='object'&&'status'in error?Number(error.status):undefined;}
function checkedArtifact(artifact:StoredArtifact):Uint8Array{
 const bytes=Buffer.from(artifact.bytes_base64,'base64');if(bytes.length!==artifact.size||'sha256:'+createHash('sha256').update(bytes).digest('hex')!==artifact.sha256)throw Object.assign(new Error('Benchmark artifact content differs from receipt'),{status:409});return bytes;
}

export async function completeCoreBenchmarkExecution(context:BenchmarkCallbackContext,jobId:string,completion:Record<string,unknown>):Promise<unknown>{
 const accepted=await benchmarkCallbackRpc<{accepted:boolean;status:string}>(context,'execution_complete',{job_id:jobId,completion});
 if(accepted.status!=='submitted'){await refillCoreBenchmarkExecutions(context,jobId);return accepted;}
 let work:CoreBenchmarkWork;
 try{work=await benchmarkCallbackRpc<CoreBenchmarkWork>(context,'load_next_work',{job_id:jobId});}catch(error){if(status(error)===409)return accepted;throw error;}
 let request:Awaited<ReturnType<typeof prepareCoreBenchmarkEvaluation>>;
 try{request=await prepareCoreBenchmarkEvaluation(work,jobId);}catch(error){if(!error||typeof error!=='object'||!('benchmarkSubmissionInvalid'in error))throw error;const rejected=await benchmarkCallbackRpc(context,'submission_reject',{job_id:jobId});await refillCoreBenchmarkExecutions(context,jobId);return rejected;}
 const prepared=await benchmarkCallbackRpc<{evaluationRunId:string}>(context,'evaluation_prepare',{job_id:jobId,request});
 await dispatchCoreBenchmarkChild(context,jobId,prepared.evaluationRunId);await refillCoreBenchmarkExecutions(context,jobId);return accepted;
}

export async function prepareCoreBenchmarkEvaluation(work:CoreBenchmarkWork,jobId:string,options:{evaluationId?:string;dispatchTarget?:{baseUrl:string;evaluatorKey:string}}={}){
 const adapter=frozenAdapter(work);const imported=work.binding.run_config.submissionSource==='imported';const task=imported?undefined:(work.request as {task:AgentTaskEnvelope}).task;
 const artifacts=work.artifacts.map(artifact=>({descriptor:{artifactId:artifact.artifactId,executionRunId:jobId,name:artifact.name,mediaType:artifact.media_type,sha256:artifact.sha256,sizeBytes:artifact.size} satisfies ArtifactDescriptor,readBytes:async()=>checkedArtifact(artifact)}));
 try{await adapter.validateSubmission(task?{task,artifacts}:{submission:{runId:jobId,publicPayload:work.case.dataset_case.publicPayload,privatePayload:work.case.dataset_case.privatePayload},artifacts});}catch{throw Object.assign(new Error('Benchmark submission validation failed'),{status:422,benchmarkSubmissionInvalid:true});}
 const evaluationId=options.evaluationId||'veval_'+createHash('sha256').update(JSON.stringify([work.handle.experiment_id,jobId,'initial-evaluation/v1'])).digest('hex').slice(0,32);const defaults=adapter.manifest.evaluation;
 const evaluationJob=adapter.buildEvaluationRequest({context:{evaluationRunId:evaluationId,executionRunId:jobId,experimentId:work.handle.experiment_id,caseId:work.handle.case_id,datasetContentHash:work.binding.dataset_content_hash},publicPayload:work.case.dataset_case.publicPayload,privatePayload:work.case.dataset_case.privatePayload,artifacts:artifacts.map(value=>value.descriptor),runConfig:{evaluatorKey:defaults.evaluatorKey,timeoutSeconds:defaults.defaultTimeoutSeconds,cpu:defaults.defaultResources.cpu,memoryMiB:defaults.defaultResources.memoryMiB,agentModel:imported?(work.binding.run_config.model||'imported/submission'):(task!.agentConfig.model||`${task!.agentConfig.platform}/${task!.agentConfig.agent}`)}});
 const origin=work.runplan.config.public_callback_origin.replace(/\/$/,'');const payload={runId:evaluationId,evaluationJob,platformBaseUrl:origin,callbackBaseUrl:origin+'/api/benchmark/v1/evaluations/'+evaluationId,timeoutSeconds:defaults.defaultTimeoutSeconds};
 const target=options.dispatchTarget||defaultEvaluatorTargetResolver.resolve(defaults.evaluatorKey);return {...payload,requestDigest:benchmarkEvaluationDispatchDigest(payload),dispatchTarget:{baseUrl:target.baseUrl,evaluatorKey:defaults.evaluatorKey}};
}

export async function dispatchCoreBenchmarkChild(context:BenchmarkCallbackContext,parentJobId:string,childJobId:string):Promise<void>{
 const dispatch=await benchmarkCallbackRpc<{handle:Record<string,unknown>;request:BenchmarkEvaluationDispatchRequest&{dispatchTarget:{baseUrl:string;evaluatorKey:string}}}>(context,'load_child_dispatch',{job_id:parentJobId,child_job_id:childJobId});
 const state=await postCoreBenchmarkEvaluation(dispatch.request,context.fetcher||fetch);
 await benchmarkCallbackRpc(context,'child_dispatch_checkpoint',{...dispatch.handle,job_id:parentJobId,child_job_id:childJobId,state});
}

async function postCoreBenchmarkEvaluation(dispatch:BenchmarkEvaluationDispatchRequest&{dispatchTarget:{baseUrl:string;evaluatorKey:string}},fetcher:typeof fetch=fetch):Promise<'accepted'|'unknown'|'failed'>{
 const {dispatchTarget,...request}=dispatch;const url=new URL(dispatchTarget.baseUrl);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Object.assign(new Error('Frozen evaluator target is invalid'),{status:409});
 let state:'accepted'|'unknown'|'failed'='unknown';
 try{
  const response=await fetcher(dispatchTarget.baseUrl.replace(/\/$/,'')+'/api/v1/evaluations',{method:'POST',redirect:'error',headers:{'content-type':'application/json','idempotency-key':request.runId,'x-agent-insight-request-digest':request.requestDigest},body:JSON.stringify(request),signal:AbortSignal.timeout(10_000)});
  const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];if(reader){for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();throw new Error('Evaluator response exceeds acknowledgement budget');}chunks.push(value);}}
  const ack=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(response.status===202&&ack?.runId===request.runId&&ack?.requestDigest===request.requestDigest&&ack?.status==='accepted')state='accepted';
  else if([400,401,403,404,405,413,415,422].includes(response.status)&&ack?.error?.retryable===false&&typeof ack.error.code==='string')state='failed';
 }catch{}
 return state;
}

export async function completeCoreBenchmarkEvaluation(context:BenchmarkCallbackContext,jobId:string,completion:BenchmarkEvaluationCompletion):Promise<unknown>{
 const accepted=await benchmarkCallbackRpc<{completion_hash:string}>(context,'evaluation_complete',{job_id:jobId,completion});
 const work=await benchmarkCallbackRpc<CoreBenchmarkWork>(context,'load_normalization_work',{job_id:jobId});
 if(work.completion_hash!==accepted.completion_hash)throw Object.assign(new Error('Raw Benchmark completion identity changed'),{status:409});
 const {normalized,mappingFailed}=normalizeCoreBenchmarkWork(work,jobId);
 const result=await benchmarkCallbackRpc(context,'normalize_commit',{job_id:jobId,raw_completion_hash:work.completion_hash,normalized});
 await refillCoreBenchmarkExecutions(context,jobId);
 if(mappingFailed)throw Object.assign(new Error('Benchmark结果归一化失败，原始结果及证据已保留'),{status:422,httpStatus:422,code:'RESULT_MAPPING_FAILED',retryable:false});
 return result;
}


export function normalizeCoreBenchmarkWork(work:CoreBenchmarkWork,jobId:string){
 const artifacts=work.artifacts.map(artifact=>{
  const bytes=checkedArtifact(artifact);const row={artifactId:artifact.artifactId,evaluationId:jobId,name:artifact.name,kind:artifact.kind,mediaType:artifact.media_type,sha256:artifact.sha256,sizeBytes:artifact.size,source:evidenceSource(work.completion.runtimeFacts,artifact.artifactId)};
  if(artifact.media_type.split(';',1)[0].trim().toLowerCase()!=='application/json')return row;
  try{return {...row,jsonContent:JSON.parse(Buffer.from(bytes).toString('utf8')) as JsonValue};}catch{return {...row,jsonParseError:'附件不是有效 JSON，原始字节仍可下载；依赖此附件判分的 Adapter 必须拒绝缺失的结构化内容'};}
 });
 const facts=work.completion.runtimeFacts as Record<string,JsonValue>;const collection=facts.evidenceCollection;
 let normalized:NormalizedBenchmarkResult;let mappingFailed=false;
 try{
  if(collection!==undefined&&!matchesEvidenceCollection(collection,artifacts.map(value=>({...value,id:value.artifactId})),work.completion.status))throw Error('评测产物清单与实际上传附件不一致或采集不完整');
  const adapter=frozenAdapter(work);normalized=adapter.normalizeResult({evaluationId:jobId,evaluatorKey:work.job.evaluator_key!,evaluationJob:(work.request as {evaluationJob:EvaluationJob}).evaluationJob,completion:work.completion,evidenceArtifacts:artifacts});
  if(normalized.status!==(work.completion.status==='failed'?'failed':'done'))throw Error('Benchmark normalized status differs from raw completion');
 }catch{mappingFailed=true;
  normalized={status:'failed',summary:'Benchmark结果归一化失败，原始结果及证据已保留',score:null,points:[],evidence:{artifactIds:work.artifacts.map(value=>value.artifactId),cleanup:work.completion.cleanup},nativeMetrics:{},errorMessage:'Benchmark结果归一化失败'};
 }
 return {normalized,mappingFailed};
}

export async function dispatchCoreBenchmarkExecution(work:CoreBenchmarkWork,rpc:(action:string,payload:Record<string,unknown>)=>Promise<unknown>,user:string):Promise<void>{
 const adapter=frozenAdapter(work);const split=adapter.validateAndSplitCase(work.case.dataset_case.rawCase);const source=work.case.dataset_case;
 if(fingerprintJson(split.publicPayload)!==fingerprintJson(source.publicPayload)||fingerprintJson(split.privatePayload)!==fingerprintJson(source.privatePayload))throw Object.assign(new Error('Benchmark Case split differs from its frozen source'),{status:409});
 const config=work.binding.run_config as BenchmarkRunConfig&{clientId:string};const {prisma}=await import('@/lib/storage/prisma');const client=await prisma.reliabilityClient.findFirst({where:{clientId:config.clientId,user,unboundAt:null}});
 if(!client)throw Object.assign(new Error('Benchmark执行客户端不存在'),{status:404});const {assertBenchmarkExecutionTarget}=await import('./execution-targets');const target=assertBenchmarkExecutionTarget(client,adapter.manifest,config);
 if(target.executionProfile?.definitionDigest!==config.executionProfile?.definitionDigest)throw Object.assign(new Error('Benchmark execution profile changed'),{status:409});
 const {benchmarkDispatchDigest}=await import('../../../packages/benchmark-protocol/src/contracts');
 const task=work.request?null:adapter.buildAgentTask({publicPayload:split.publicPayload,runConfig:config,context:{runId:work.handle.job_id,experimentId:work.handle.experiment_id,caseId:work.handle.case_id}});
 const base={runId:work.handle.job_id,task:task!,callbackBaseUrl:work.runplan.config.executor_callback_origin.replace(/\/$/,'')+'/api/benchmark/v1/runs/'+work.handle.job_id,timeoutSeconds:config.timeoutSeconds};const request=work.request||{...base,requestDigest:benchmarkDispatchDigest(base),clientId:config.clientId};
 await rpc('checkpoint',{...work.handle,request,operation_key:'benchmark-seal:'+work.handle.job_id,operation_request:{job_id:work.handle.job_id,request}});const sealed=await rpc('load_dispatch',work.handle) as {request:Record<string,unknown>};const {clientId,...wire}=sealed.request;void clientId;
 const {dispatchBenchmarkCommandForCore}=await import('./scheduler');let outcome:Awaited<ReturnType<typeof dispatchBenchmarkCommandForCore>>|null=null;
 try{outcome=await dispatchBenchmarkCommandForCore({user,clientId:config.clientId,request:wire});}catch{}
 const state=outcome?.status==='accepted'?'accepted':outcome?.status==='rejected'?'failed':'unknown';const command=outcome?.commandId||null;
 await rpc('dispatch_checkpoint',{...work.handle,state,command_id:command,operation_key:'benchmark-command:'+work.handle.job_id+':'+(command||'unknown'),operation_request:{job_id:work.handle.job_id,command_id:command,state}});
}

export async function startCoreBenchmarkExperiment(input:{experimentId:string;user:string;publicCallbackOrigin:string;executorCallbackOrigin:string;resumeOnly?:boolean}):Promise<{status:'running';alreadyRunning:boolean;runId:string|null;completion?:Promise<void>}|null>{
 const {requireCoreExperimentContext}=await import('@/lib/storage-core/experiments');const context=requireCoreExperimentContext();if(context.actor.username!==input.user)throw Object.assign(new Error('Benchmark actor mismatch'),{status:403});
 let start:{status:'running'|'idle';alreadyRunning:boolean;runId:string|null};
 if(input.resumeOnly){
  const previous=await context.rpc('read',{experiment_id:input.experimentId}) as {experiment:{status:string};current_run_id:string|null};if(previous.experiment.status!=='running')return null;
  start=await benchmarkCoreRpc('start',{experiment_id:input.experimentId,resume_only:true,expected_runplan_id:previous.current_run_id,operation_key:context.operationKey+':benchmark-resume',operation_request:{experiment_id:input.experimentId,runplan_id:previous.current_run_id,resume_only:true}});
 }else{
  const {prepareCoreExperimentStart}=await import('@/lib/storage-core/experiment-assets');const prepared=await prepareCoreExperimentStart(context,input.experimentId);
  const {platformBenchmarkConfig}=await import('./project-config');const scheduling=platformBenchmarkConfig().scheduling;
  start=await benchmarkCoreRpc('start',{...prepared.payload,experiment_id:input.experimentId,public_callback_origin:input.publicCallbackOrigin,executor_callback_origin:input.executorCallbackOrigin,scheduler_limits:{maxPendingEvaluations:scheduling.maxPendingEvaluations,maxPendingEvaluationsPerUser:scheduling.maxPendingEvaluationsPerUser}});
 }
 if(start.status!=='running')return null;
 const jobs=await benchmarkCoreRpc<Array<{job_id:string;kind:string;protocol_state:string}>>('list_jobs',{experiment_id:input.experimentId});const completion=(async()=>{
  for(const job of jobs){
   if(job.kind!=='execute'||!['pending','preparing','dispatching','dispatch_unknown'].includes(job.protocol_state))continue;
   let work:CoreBenchmarkWork|null;
   if(job.protocol_state==='pending'){const handle=await benchmarkCoreRpc<Record<string,unknown>|null>('claim',{job_id:job.job_id,worker_id:'benchmark-executor-controller'});if(!handle)continue;work=await benchmarkCoreRpc<CoreBenchmarkWork>('load_work',handle);}else work=await benchmarkCoreRpc<CoreBenchmarkWork|null>('resume_work',{job_id:job.job_id});
   if(work)try{await dispatchCoreBenchmarkExecution(work,benchmarkCoreRpc,context.actor.username);}catch(error){await failCoreBenchmarkPreparation(work,benchmarkCoreRpc);throw error;}
  }
 })();return {...start,status:'running',completion};
}


async function failCoreBenchmarkPreparation(work:CoreBenchmarkWork,rpc:(action:string,payload:Record<string,unknown>)=>Promise<unknown>):Promise<void>{
 try{await rpc('dispatch_checkpoint',{...work.handle,state:'failed',preparation_failed:true,operation_key:'benchmark-preparation-failed:'+work.handle.job_id,operation_request:{job_id:work.handle.job_id,phase:'preparation'}});}catch{}
}
export async function refillCoreBenchmarkExecutions(context:BenchmarkCallbackContext,parentJobId:string):Promise<void>{
 for(let index=0;index<1000;index++){
  const work=await benchmarkCallbackRpc<CoreBenchmarkWork|null>(context,'claim_next_execution',{job_id:parentJobId});if(!work)return;
  const rpc=async(action:string,payload:Record<string,unknown>)=>benchmarkCallbackRpc(context,'execution_stage',{...payload,execution_action:action,target_job_id:work.handle.job_id,job_id:parentJobId});
  const owner=work.binding.run_config.legacyOwner;if(!owner)throw Object.assign(new Error('Frozen Benchmark legacy owner mapping is unavailable'),{status:503});if(context.verifiedDeviceOwner&&context.verifiedDeviceOwner!==owner)throw Object.assign(new Error('Benchmark callback device owner differs from frozen mapping'),{status:403});
  try{await dispatchCoreBenchmarkExecution(work,rpc,owner);}catch(error){await failCoreBenchmarkPreparation(work,rpc);throw error;}
 }
}


export async function resumeCoreBenchmarkIntents(options:{limit?:number;workerId?:string}={}):Promise<{completed:number;deferred:number}>{
 const {requireCoreExperimentContext}=await import('@/lib/storage-core/experiments');const context=requireCoreExperimentContext();const worker=options.workerId||'benchmark-intents-'+randomUUID().replaceAll('-','');let completed=0,deferred=0;const limit=options.limit??20;if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Object.assign(new Error('Bounded Benchmark recovery limit required'),{status:400});
 for(let index=0;index<limit;index++){
  const intents=await benchmarkCoreRpc<Array<{handle:Record<string,unknown>;event_type:string;job:{kind:string;job_id:string};actor_username:string;failure_source_hash?:string;request?:Record<string,unknown>;work?:CoreBenchmarkWork}>>('claim_intents',{worker_id:worker,limit:1});const intent=intents[0];if(!intent)break;
  const finish=async(operation:string,payload:Record<string,unknown>)=>benchmarkCoreRpc('finish_intent',{...intent.handle,operation,...payload,operation_key:'benchmark-intent:'+intent.handle.event_id+':'+intent.handle.outbox_attempt,operation_request:{event_id:intent.handle.event_id,outbox_attempt:intent.handle.outbox_attempt,operation,...payload}});
  try{
  if(intent.event_type==='benchmark.execution.prepare.requested.v1'){
   try{await dispatchCoreBenchmarkExecution(intent.work!,benchmarkCoreRpc,context.actor.username);}catch(error){await failCoreBenchmarkPreparation(intent.work!,benchmarkCoreRpc);throw error;}
  }else if(intent.event_type==='benchmark.dispatch.requested.v1'){
   let state:'accepted'|'unknown'|'failed'='unknown';let command:string|null=null;
   if(intent.job.kind==='evaluate')state=await postCoreBenchmarkEvaluation(intent.request as unknown as BenchmarkEvaluationDispatchRequest&{dispatchTarget:{baseUrl:string;evaluatorKey:string}},context.options.fetcher||fetch);
   else{const request={...intent.request};const clientId=String(request.clientId||'');delete request.clientId;const {dispatchBenchmarkCommandForCore}=await import('./scheduler');try{const outcome=await dispatchBenchmarkCommandForCore({user:context.actor.username,clientId,request});state=outcome.status==='accepted'?'accepted':outcome.status==='rejected'?'failed':'unknown';command=outcome.commandId;}catch{}}
   await finish('dispatch_ack',{state,command_id:command});
  }else if(intent.event_type==='benchmark.continuation.requested.v1'){
   await finish('prepare_continuation',{});
  }else if(intent.event_type==='benchmark.failure.classification.requested.v1'){
   await finish('classify_failure',{failure_source_hash:intent.failure_source_hash});
  }else if(intent.event_type==='benchmark.execution.completed.v1'){
   try{const request=await prepareCoreBenchmarkEvaluation(intent.work!,intent.job.job_id);await finish('prepare_evaluation',{request});}catch(error){if(!error||typeof error!=='object'||!('benchmarkSubmissionInvalid'in error))throw error;await finish('submission_reject',{});}
  }else if(intent.event_type==='benchmark.evaluation.raw.accepted.v1'){
   const {normalized}=normalizeCoreBenchmarkWork(intent.work!,intent.job.job_id);await finish('normalize',{raw_completion_hash:intent.work!.completion_hash,normalized});
  }else throw Object.assign(new Error('Unsupported Benchmark recovery intent'),{status:503});
  completed++;
  }catch(error){
   try{await finish('defer',{reason:status(error)!==undefined&&Number(status(error))>=500?'STORAGE_UNAVAILABLE':'ADAPTER_UNAVAILABLE'});}catch(failure){if(![401,403,409].includes(status(failure)||0))throw failure;}
   deferred++;
  }
 }
 return {completed,deferred};
}

export async function importCoreBenchmarkSubmissions(input:{experimentId:string;publicCallbackOrigin:string;submissions:Array<{dataset_case_id:string;artifacts:Array<{name:string;media_type:string;expected_sha256:string;bytes_base64:string}>}>}):Promise<{accepted:boolean;experiment_id:string;runplan_id:string;jobs:Array<{job_id:string}>;submissionSource:'imported'}>{
 const {requireCoreExperimentContext}=await import('@/lib/storage-core/experiments');const context=requireCoreExperimentContext();const key=context.operationKey+':import-submissions';const request={experiment_id:input.experimentId,public_callback_origin:input.publicCallbackOrigin,submissions:input.submissions};const old=await benchmarkCoreRpc<Awaited<ReturnType<typeof importCoreBenchmarkSubmissions>>|null>('lookup_operation',{kind:'import_submissions',operation_key:key,operation_request:request});if(old)return old;
 const {prepareCoreExperimentStart}=await import('@/lib/storage-core/experiment-assets');const prepared=await prepareCoreExperimentStart(context,input.experimentId);return benchmarkCoreRpc('import_submissions',{...prepared.payload,...request,executor_callback_origin:input.publicCallbackOrigin,operation_key:key,operation_request:request});
}

export async function dispatchCoreBenchmarkEvaluationForOwner(jobId:string):Promise<void>{
 const handle=await benchmarkCoreRpc<Record<string,unknown>|null>('claim',{job_id:jobId,worker_id:'benchmark-owner-evaluator-controller'});if(!handle)return;
 const work=await benchmarkCoreRpc<CoreBenchmarkWork>('load_work',handle);await benchmarkCoreRpc('checkpoint',{...handle,request:work.request,operation_key:'benchmark-owner-eval-seal:'+jobId});const context=(await import('@/lib/storage-core/experiments')).requireCoreExperimentContext();const dispatch=await benchmarkCoreRpc<{request:BenchmarkEvaluationDispatchRequest&{dispatchTarget:{baseUrl:string;evaluatorKey:string}}}>('load_dispatch',handle);const state=await postCoreBenchmarkEvaluation(dispatch.request,context.options.fetcher||fetch);await benchmarkCoreRpc('dispatch_checkpoint',{...handle,state,operation_key:'benchmark-owner-eval-ack:'+jobId+':'+state});
}

export async function dispatchCoreBenchmarkExecutionForOwner(jobId:string):Promise<void>{
 const context=(await import('@/lib/storage-core/experiments')).requireCoreExperimentContext();
 const handle=await benchmarkCoreRpc<Record<string,unknown>|null>('claim',{job_id:jobId,worker_id:'benchmark-owner-executor-controller'});if(!handle)return;
 const work=await benchmarkCoreRpc<CoreBenchmarkWork>('load_work',handle);
 try{await dispatchCoreBenchmarkExecution(work,benchmarkCoreRpc,context.actor.username);}catch(error){await failCoreBenchmarkPreparation(work,benchmarkCoreRpc);throw error;}
}
