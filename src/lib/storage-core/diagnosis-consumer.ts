import {buildDebugTurns} from '@/lib/engine/agent-debug/trace-adapter';
import {normalizeClaudeCodeInteractionsForStorage} from '@/lib/shared/interaction-content';
import {inferSubagentNamesFromInteractions} from '@/lib/engine/observability/subagent-inference';
import {randomUUID} from 'node:crypto';
import {prismaRaw} from '@/lib/storage/prisma';
import {getActiveConfig} from '@/lib/storage/server-config';
import {loadSkillVersionSnapshot} from '@/lib/engine/skill-opt/version-snapshot';
import {AGENT_DEBUG_GENERATOR} from '@/lib/engine/agent-debug/types';
import {contentHash,DiagnosisError,type DiagnosisSnapshot} from '@/lib/diagnosis/contracts';
import type {AgentDebugReportPayload} from '@/lib/engine/agent-debug/types';
import {requireCoreExperimentContext,type CoreExperimentContext} from './experiments';
import {requestCore} from './server';
import {controllerHeaders} from './controller';
import {freezeModelSelection} from './frozen-model';

const GENERATOR=AGENT_DEBUG_GENERATOR+':evaluation-input-v1';
const frozen=new WeakMap<DiagnosisSnapshot,{body:Record<string,unknown>;inputHash:string}>();
const running=new Set<string>();
export interface CoreDiagnosisRun {
 id:string;status:string;errorMessage:string|null;createdAt:string;input_hash:string;snapshot:DiagnosisSnapshot;
 source_model_selection?:Record<string,unknown>|null;source_model_selection_consistent?:boolean;source_runplans?:unknown[];
 historical_inert?:boolean;
 report:AgentDebugReportPayload|null;progress:unknown;execution_id:string;experiment_id:string|null;case_id:string|null;
}
function visibleDiagnosis(value:CoreDiagnosisRun){const {historical_inert,...visible}=value;return {...visible,status:visible.status==='queued'?'pending':visible.status};}
export async function diagnosisCoreRequest<T=CoreDiagnosisRun>(action:string,payload:Record<string,unknown>={},context=requireCoreExperimentContext()):Promise<T>{
 const body=JSON.stringify({...payload,action,operation_key:payload.operation_key||context.operationKey+':diagnosis:'+action});
 if(Buffer.byteLength(body,'utf8')>24*1024*1024)throw Object.assign(new Error('Diagnosis evidence exceeds byte budget'),{status:413});
 const headers=['preview','submit','freeze_report'].includes(action)?await controllerHeaders(context.actor,body,'experiment-frozen-assets/v1'):{};
 for(let attempt=0;attempt<3;attempt++){
  try{const {data}=await requestCore('/v1/compat/diagnosis-runs?'+new URLSearchParams({workspace_id:context.actor.workspace}),{token:context.actor.token,method:'POST',body,headers,responseLimit:64*1024*1024,timeoutMs:120_000},context.options.fetcher||fetch);if(!Object.hasOwn(data,'value'))throw Object.assign(new Error('Invalid Diagnosis response'),{status:502});return data.value as T;}
  catch(error){const status=error&&typeof error==='object'&&'status'in error?error.status:undefined;if(attempt===2||(status!==undefined&&status!==502&&status!==503))throw error;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}
 }
 throw Object.assign(new Error('Diagnosis storage unavailable'),{status:503});
}
export async function freezeCoreDiagnosisAssets(){
 const context=requireCoreExperimentContext();
 const rows=await prismaRaw.skill.findMany({where:{OR:[{user:context.actor.username},{user:null}]},include:{versions:{orderBy:{version:'asc'}}},orderBy:{id:'asc'},take:1001});
 if(rows.length>1000)throw Object.assign(new Error('Diagnosis Skill catalog exceeds budget'),{status:413});
 const flows=rows.length?await prismaRaw.parsedFlow.findMany({where:{skillId:{in:rows.map(row=>row.id)},OR:[{user:context.actor.username},{user:null}]}}):[];
 const frozenSkills=rows.sort((a,b)=>Number(b.user===context.actor.username)-Number(a.user===context.actor.username)||a.id.localeCompare(b.id)).map(row=>({id:row.id,name:row.name,user:row.user,activeVersion:row.activeVersion,versions:row.versions.map(version=>{
  const files=loadSkillVersionSnapshot({skillId:row.id,version:version.version,row:version});
  let declared:unknown;try{declared=JSON.parse(version.files||'[]');}catch{declared=null;}
  const complete=Array.isArray(declared)&&declared.every(file=>typeof file==='string'&&(file.toLowerCase()==='skill.md'||Object.hasOwn(files,file)));
  return {version:version.version,content:version.content,semanticVersion:version.semanticVersion,files:complete?files:null,contentHash:complete?contentHash(files):null};
 }),parsedFlows:flows.filter(flow=>flow.skillId===row.id)}));
 return {frozen_skills:frozenSkills,model_selection:freezeModelSelection(await getActiveConfig(context.actor.username)),generator:GENERATOR};
}
export async function buildCoreDiagnosisSnapshot(experimentId:string,caseId:string,resultIds:string[]):Promise<DiagnosisSnapshot>{
 const body={source_kind:'experiment',experiment_id:experimentId,case_id:caseId,result_ids:[...new Set(resultIds)].sort(),...await freezeCoreDiagnosisAssets()};
 const value=await diagnosisCoreRequest<{snapshot:DiagnosisSnapshot;input_hash:string}>('preview',body);
 if(!value.snapshot||!/^[0-9a-f]{64}$/.test(value.input_hash))throw Object.assign(new Error('Frozen Diagnosis input unavailable'),{status:503});
 if(!buildDebugTurns(prepareCoreDiagnosisExecution(value.snapshot).interactions).length)throw new DiagnosisError('被测执行没有可诊断的轨迹',422);
 frozen.set(value.snapshot,{body,inputHash:value.input_hash});return value.snapshot;
}
export function coreDiagnosisSnapshotHash(snapshot:DiagnosisSnapshot){return frozen.get(snapshot)?.inputHash;}
export async function submitCoreDiagnosis(snapshot:DiagnosisSnapshot,input:{requestKey:string;expectedInputHash:string;force?:boolean;retryOfRunId?:string}){
 const prepared=frozen.get(snapshot);if(!prepared)throw new DiagnosisError('请重新预览并确认诊断输入',409);
 if(input.expectedInputHash!==prepared.inputHash)throw new DiagnosisError('评测或执行已变化，请重新确认输入',409);
 const run=await diagnosisCoreRequest('submit',{...prepared.body,request_key:input.requestKey,expected_input_hash:input.expectedInputHash,force:input.force||false,retry_of_run_id:input.retryOfRunId||null});
 if(!run.historical_inert&&['queued','pending','running'].includes(run.status)){await launchCoreDiagnosis(run.id);return readCoreDiagnosis(run.id);}
 return visibleDiagnosis(run);
}
export async function lookupCoreDiagnosisSubmission(experimentId:string,caseId:string,input:{resultIds:string[];requestKey:string;expectedInputHash:string;retryOfRunId?:string}):Promise<CoreDiagnosisRun|null>{
 const receipt=await diagnosisCoreRequest<{found:boolean;result?:CoreDiagnosisRun}>('lookup_submission',{source_kind:'experiment',experiment_id:experimentId,case_id:caseId,result_ids:[...new Set(input.resultIds)].sort(),request_key:input.requestKey,expected_input_hash:input.expectedInputHash,retry_of_run_id:input.retryOfRunId||null});
 if(receipt?.found===false)return null;
 if(receipt?.found!==true||!receipt.result?.id)throw Object.assign(new Error('Diagnosis submission receipt unavailable'),{status:503});
 const run=receipt.result;
 if(!run.historical_inert&&['queued','pending','running'].includes(run.status)){await launchCoreDiagnosis(run.id);return readCoreDiagnosis(run.id);}
 return visibleDiagnosis(run);
}
export async function readCoreDiagnosis(id:string){return visibleDiagnosis(await diagnosisCoreRequest('read',{diagnosis_id:id}));}
export function verifyCoreDiagnosisSource(id:string){return diagnosisCoreRequest<{valid:true;historical_origin?:boolean}>('verify_source',{diagnosis_id:id});}
export async function listCoreDiagnoses(experimentId:string,caseId:string){const rows=await diagnosisCoreRequest<Array<{id:string;status:string;createdAt:string}>>('list',{experiment_id:experimentId,case_id:caseId,limit:10});return rows.map(row=>({id:row.id,status:row.status==='queued'?'pending':row.status,createdAt:row.createdAt}));}
export async function freezeCoreTraceReport(executionId:string,generatedAt:string){
 const body={source_kind:'trace-report',execution_id:executionId,generated_at:generatedAt,...await freezeCoreDiagnosisAssets()};
 const preview=await diagnosisCoreRequest<{input_hash:string}>('preview',body);
 const value=await diagnosisCoreRequest('submit',{...body,request_key:preview.input_hash,expected_input_hash:preview.input_hash});return {runId:value.id};
}
export function prepareCoreDiagnosisExecution(snapshot:DiagnosisSnapshot):DiagnosisSnapshot{
 let interactions=structuredClone(snapshot.interactions);
 if(snapshot.execution.framework==='claudecode')interactions=normalizeClaudeCodeInteractionsForStorage(interactions);
 interactions=inferSubagentNamesFromInteractions(interactions as Parameters<typeof inferSubagentNamesFromInteractions>[0]);
 return {...snapshot,interactions};
}
async function launchCoreDiagnosis(id:string){
 const context=requireCoreExperimentContext();const key=context.actor.workspace+':'+id;if(running.has(key))return;
 const handle=await diagnosisCoreRequest<Record<string,unknown>|null>('claim',{diagnosis_id:id,worker_id:'diagnosis-'+randomUUID()});if(!handle)return;
 running.add(key);void executeCoreDiagnosis(context,id,handle).catch(error=>console.error('[core-diagnosis] persistence failure',error)).finally(()=>running.delete(key));
}
async function executeCoreDiagnosis(context:CoreExperimentContext,id:string,handle:Record<string,unknown>){
 const {runWithCoreExperimentContext,prepareCoreExperimentRuntime}=await import('./experiments');
 await runWithCoreExperimentContext(context,async()=>{
  const {createDiagnosisProgress,sanitizeProgressText}=await import('@/lib/engine/agent-debug/progress-store');
  const work=await diagnosisCoreRequest<{handle:Record<string,unknown>;snapshot:DiagnosisSnapshot;runplan:{config:{model_selection:Record<string,unknown>|null}}}>('load_work',{...handle,diagnosis_id:id});
  const snapshot=prepareCoreDiagnosisExecution(work.snapshot);const progress=createDiagnosisProgress({user:context.actor.username,executionId:snapshot.execution.id,runId:id});
  const controller=new AbortController();let renewing=false;
  const timer=setInterval(()=>{if(renewing)return;renewing=true;void diagnosisCoreRequest('renew',{...work.handle,diagnosis_id:id,progress:progress.snapshot()}).catch(error=>controller.abort(error)).finally(()=>{renewing=false;});},15_000);timer.unref();
  try{
   progress.emit({key:'accepted',kind:'task',state:'started',title:'诊断输入已冻结',summary:`${snapshot.results.length} 项评测结果，等待诊断资源。`});
   const {withBackgroundOpencodeSlot}=await import('@/lib/engine/general-agent/concurrency-limiter');const {runAgentDebugDiagnosis}=await import('@/lib/engine/agent-debug/runner');
   const report=await prepareCoreExperimentRuntime(context,work,()=>withBackgroundOpencodeSlot(()=>runAgentDebugDiagnosis({execution:snapshot.execution,interactions:snapshot.interactions,user:context.actor.username,progress,evaluationContext:{...snapshot,interactions:undefined}}),{user:context.actor.username,taskType:'agent-debug',label:`evaluation-diagnosis: ${id}`}),{signal:controller.signal});
   controller.signal.throwIfAborted();progress.emit({key:'done',kind:'task',state:'completed',title:'诊断完成',summary:'报告与输入快照已保存。'});
   await diagnosisCoreRequest('complete',{...work.handle,diagnosis_id:id,report,progress:progress.snapshot(),operation_key:id+':complete:'+String(work.handle.attempt_id)});
  }catch(error){
   const message=sanitizeProgressText(error instanceof Error?error.message:'诊断失败');progress.emit({key:'failed',kind:'task',state:'failed',title:'诊断失败',summary:message});
   await diagnosisCoreRequest('fail',{...work.handle,diagnosis_id:id,error_message:message,progress:progress.snapshot(),operation_key:id+':fail:'+String(work.handle.attempt_id)});
  }finally{clearInterval(timer);}
 });
}
