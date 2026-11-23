import { createHash } from 'node:crypto';
import { compatibilityFailure,type CompatibilityOptions } from './compat';
import { coreReportRequest,readCoreStoredReport,requireCoreReportContext,resolveCoreReportEvidence,withCoreReports,type CoreReportKind,type CoreReportLease,type CoreStoredReport } from './reports';
import { readCoreBytes,requestCore } from './server';
import { DiagnosisTextQueue } from './diagnosis-stream';
import { diagnosisWorkspace } from './diagnosis';
import { runWithTrustedCoreAgentContext,resolveGeneralAgentModel,type TrustedCoreAgentContext } from '@/lib/engine/general-agent/runner';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { resolveAgentDebugExecution,type AgentDebugExecutionRecord } from '@/lib/engine/agent-debug/execution-resolver';
import { hashInteractions } from '@/lib/engine/agent-debug/trace-adapter';
import { AGENT_DEBUG_GENERATOR } from '@/lib/engine/agent-debug/types';
import { sanitizeProgressText } from '@/lib/engine/agent-debug/progress-store';
import type { DiagnosisProgressWriter,DiagnosisProgressSnapshot } from '@/lib/engine/agent-debug/progress-types';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';

interface ExecuteInput {kind:CoreReportKind;execution:AgentDebugExecutionRecord;interactions:unknown[];user:string;progress:DiagnosisProgressWriter;runtime:TrustedCoreAgentContext}
export interface CoreReportHandlerOptions extends CompatibilityOptions {
 execute?:(input:ExecuteInput)=>Promise<Record<string,unknown>>;
 model?:typeof resolveGeneralAgentModel;
 workspace?:(key:string)=>string;
 background?:(run:()=>Promise<void>,user:string)=>Promise<void>;
}
const error=(status:number,message:string)=>Object.assign(new Error(message),{status});
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'cache-control':'no-store'}});
const jobs=new Map<string,Promise<void>>();
const generator=(kind:CoreReportKind)=>kind==='agent-debug'?AGENT_DEBUG_GENERATOR:'agent-debug-skills-analysis@core-1';

function publicRow(value:CoreStoredReport,kind:CoreReportKind){
 if(!value.row)return null;
 const names=kind==='agent-debug'?['id','executionId','status','errorMessage','interactionsHash','stepCount','issueCount','llmCallCount','durationMs','generator','ranAt','updatedAt']:['id','executionId','status','errorMessage','interactionsHash','keyActionCount','ranAt','updatedAt'];
 return Object.fromEntries(names.map(key=>[key,value.row![key]]));
}
function skillsPayload(value:CoreStoredReport){
 if(!value.payload)return null;
 const payload=value.row?.status==='failed'&&value.payload.status==='running'?{...value.payload,status:'failed',errorMessage:value.row.errorMessage}:value.payload;
 return {...payload,progress:value.progress};
}
function reportResponse(value:CoreStoredReport,kind:CoreReportKind,extra:Record<string,unknown>={}){
 return kind==='agent-debug'?{report:value.row?.status==='done'?value.payload:null,row:publicRow(value,kind),progress:value.progress,...extra}
  :{row:publicRow(value,kind),skillsAnalysis:skillsPayload(value),...extra};
}
function coreProgress(kind:CoreReportKind,lease:CoreReportLease,abort:AbortController){
 const state:DiagnosisProgressSnapshot={runId:lease.id,events:[],lastProgressAt:null,unavailable:false,truncated:false};
 const keys=new Set<string>();let sequence=0;
 const queue=new DiagnosisTextQueue(async()=>{},()=>{},cause=>{state.unavailable=true;abort.abort(cause);});
 const checkpoint=()=>{
  const snapshot=structuredClone(state);const size=Buffer.byteLength(JSON.stringify(snapshot),'utf8');
  queue.effect(async()=>{
   const saved=await coreReportRequest(kind,{method:'PATCH',reportId:lease.id,body:{revision:lease.revision,leaseToken:lease.leaseToken,progress:snapshot}});
   if(!saved.row||saved.row.id!==lease.id||saved.row.status!=='running')throw error(503,'Invalid report progress response');lease.revision=String(saved.row.revision);
  },size);
 };
 const writer:DiagnosisProgressWriter={runId:lease.id,emit(event){
  if(keys.has(event.key))return;keys.add(event.key);if(keys.size>2000)keys.delete(keys.values().next().value!);
  const at=new Date().toISOString();state.events.push({...event,key:event.key.slice(0,180),title:sanitizeProgressText(event.title).slice(0,160),summary:sanitizeProgressText(event.summary),refs:event.refs?.slice(0,12),seq:++sequence,at});
  if(state.events.length>200){state.events.shift();state.truncated=true;}state.lastProgressAt=at;
  checkpoint();
 },snapshot:()=>structuredClone(state),unavailable(){state.unavailable=true;abort.abort(error(503,'Report progress unavailable'));}};
 return {writer,flush:()=>queue.flush(),renew:async()=>{checkpoint();await queue.flush();}};
}
async function execute(input:ExecuteInput){
 return runWithTrustedCoreAgentContext(input.runtime,async()=>{
  if(input.kind==='agent-debug'){
   const {runAgentDebugDiagnosis}=await import('@/lib/engine/agent-debug/runner');
   return await runAgentDebugDiagnosis(input) as unknown as Record<string,unknown>;
  }
  const {runAgentDebugSkillsAnalysis}=await import('@/lib/engine/agent-debug/skills-analysis');
  return await runAgentDebugSkillsAnalysis({...input,interactionHash:hashInteractions(input.interactions)}) as unknown as Record<string,unknown>;
 });
}

export async function handleCoreReport(request:Request,executionId:string,kind:CoreReportKind,options:CoreReportHandlerOptions={}):Promise<Response>{
 try{return await withCoreReports(request,async()=>{
  const context=requireCoreReportContext();const user=context.actor.username;
  if(request.method==='DELETE'){
   if(kind!=='agent-debug')throw error(405,'Unsupported report operation');
   try{await coreReportRequest(kind,{method:'DELETE',executionId});}catch(cause){if(!(cause instanceof Error&&'status'in cause&&cause.status===404))throw cause;}
   return json({ok:true});
  }
  if(request.method==='GET'){
   let stored:CoreStoredReport;
   try{stored=await readCoreStoredReport(executionId,kind);}catch(cause){if(cause instanceof Error&&'status'in cause&&cause.status===404)return json(kind==='agent-debug'?{report:null,row:null}:{skillsAnalysis:null,row:null});throw cause;}
   let stale=false;
   if(kind==='skills-analysis'&&stored.row){
    const resolved=await resolveAgentDebugExecution(executionId);
    stale=!resolved||hashInteractions(resolved.interactions)!==stored.row.interactionsHash;
    if(stale)stored={...stored,payload:null};
   }
   return json(reportResponse(stored,kind,kind==='skills-analysis'?{stale}:{}));
  }
  if(request.method!=='POST')throw error(405,'Unsupported report operation');
  let body:Record<string,unknown>;
  try{const raw=await readCoreBytes(request.body,64*1024);body=raw.length?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)):{};}
  catch(cause){if(cause instanceof Error&&'status'in cause&&cause.status===413)throw cause;throw error(400,'Invalid report request');}
  if(!body||typeof body!=='object'||Array.isArray(body)||(body.force!==undefined&&typeof body.force!=='boolean'))throw error(400,'Invalid report request');
  const evidence=await resolveCoreReportEvidence(executionId);
  const resolved=await resolveAgentDebugExecution(executionId);if(!resolved)throw error(404,'Execution not found');
  const interactionsHash=hashInteractions(resolved.interactions);
  const requestKey=request.headers.get('idempotency-key');if(requestKey!==null&&!/^[\x21-\x7e]{1,512}$/.test(requestKey))throw error(400,'Invalid report request key');
  const previous=kind==='skills-analysis'?await readCoreStoredReport(executionId,kind):null;
  const canReuseSkills=previous?.row?.interactionsHash===interactionsHash&&previous.payload?.status==='done'&&Array.isArray(previous.payload.keyActionResults)&&previous.payload.keyActionResults.length>0;
  const force=body.force===true||(kind==='skills-analysis'&&!canReuseSkills);
  const running=kind==='skills-analysis'?{status:'running',source:'agent-debug',interactionHash:interactionsHash}:undefined;
  const started=await coreReportRequest(kind,{method:'POST',body:{executionId,expectedSnapshotHash:evidence.snapshot_hash,interactionsHash,generator:generator(kind),force,...(requestKey!==null?{requestKey}:{}),...(running?{payload:running}:{})}});
  if(!started.row)throw error(503,'Report reservation unavailable');
  if(started.cached)return json(reportResponse(started,kind,{cached:true}));
  if(started.busy)return json(reportResponse(started,kind,{status:'running'}),409);
  if(!started.leaseToken)throw error(503,'Report publication lease unavailable');
  const lease:CoreReportLease={id:started.row.id,revision:String(started.row.revision),leaseToken:started.leaseToken};
  const abort=new AbortController();
  const progress=coreProgress(kind,lease,abort);const receipts:Array<{state:string;task_id:string}>=[];
  progress.writer.emit({key:'accepted',kind:'task',state:'started',title:kind==='agent-debug'?'诊断请求已接收':'Skills 核验已开始',summary:'输入证据已冻结，等待执行资源。'});
  const workspaceKey='diagnosis-'+createHash('sha256').update(JSON.stringify(['report',context.actor.workspace,user,lease.id])).digest('hex');
  let model:Awaited<ReturnType<typeof resolveGeneralAgentModel>>;let workspaceDir:string;
  try{model=await(options.model||resolveGeneralAgentModel)(user);workspaceDir=(options.workspace||diagnosisWorkspace)(workspaceKey);}
  catch(cause){await progress.flush().catch(()=>{});await coreReportRequest(kind,{method:'PATCH',reportId:lease.id,body:{revision:lease.revision,leaseToken:lease.leaseToken,status:'failed',errorMessage:'诊断准备失败，请重试。'}}).catch(()=>{});throw cause;}
  const runtime:TrustedCoreAgentContext={trustedWorkspaceDir:workspaceDir,trustedModel:model,cancelSignal:abort.signal,
   recordCoreTrace:async payload=>{
    try{
    const {data}=await requestCore('/v1/compat/observe/agent-traces?'+new URLSearchParams({workspace_id:context.actor.workspace}),{token:context.actor.token,method:'POST',body:JSON.stringify({...payload,context:{parent_trace_id:evidence.manifest.trace_id,report_run_id:lease.id,report_lease_token:lease.leaseToken}}),timeoutMs:295_000,responseLimit:1024*1024},context.options.fetcher||fetch);
    const receipt=data.value as {state?:string;task_id?:string};
    if(receipt?.state!=='indexed'||typeof receipt.task_id!=='string'||receipt.task_id!==payload.record.task_id)throw error(503,'Report Agent Trace not indexed');
    if(receipts.length>=4096)throw error(413,'Too many report Agent Traces');receipts.push({state:'indexed',task_id:receipt.task_id});
    }catch(cause){abort.abort(cause);throw cause;}
   }};
  const key=JSON.stringify([context.actor.workspace,kind,lease.id]);
  let renewing=false;let heartbeat:Promise<void>=Promise.resolve();
  const timer=setInterval(()=>{
   if(renewing||abort.signal.aborted)return;renewing=true;
   heartbeat=progress.renew().catch(cause=>abort.abort(cause)).finally(()=>{renewing=false;});
  },15_000);timer.unref();
  const run=async()=>{
   try{
    await progress.renew();abort.signal.throwIfAborted();
    const payload=await runWithTrustedCoreAgentContext(runtime,()=> (options.execute||execute)({kind,execution:resolved.execution,interactions:resolved.interactions,user,progress:progress.writer,runtime}));
    clearInterval(timer);await heartbeat;abort.signal.throwIfAborted();
    const status=payload.status==='skipped'?'skipped':'done';
    await progress.flush();abort.signal.throwIfAborted();
    const finalProgress=progress.writer.snapshot();
    if(kind==='agent-debug'){
     const at=new Date().toISOString();const skipped=typeof payload.skippedReason==='string'?payload.skippedReason:null;
     finalProgress.events.push({key:'done',kind:'task',state:skipped?'skipped':'completed',title:skipped?'诊断未运行':'诊断报告已归档',summary:skipped||'最终报告已返回，以下结论以最终报告为准。',seq:(finalProgress.events.at(-1)?.seq||0)+1,at});
     if(finalProgress.events.length>200){finalProgress.events.shift();finalProgress.truncated=true;}finalProgress.lastProgressAt=at;
    }
    const savedPayload={...payload,...(kind==='skills-analysis'?{runId:lease.id}:{}),coreTraceReceipts:receipts};
    if(kind==='agent-debug')delete (savedPayload as Record<string,unknown>).skillsAnalysis;
    await coreReportRequest(kind,{method:'PATCH',reportId:lease.id,body:{revision:lease.revision,leaseToken:lease.leaseToken,status,payload:savedPayload,progress:finalProgress}});
   }catch{
    clearInterval(timer);await heartbeat;
    progress.writer.emit({key:'failed',kind:'task',state:'failed',title:'诊断中断',summary:'已保留获得的阶段内容，请重新诊断。'});
    await progress.flush().catch(()=>{});
    const payload=kind==='skills-analysis'?{status:'failed',source:'agent-debug',interactionHash:interactionsHash,runId:lease.id,errorMessage:'Skills 核验未完成，请重试。',coreTraceReceipts:receipts}:undefined;
    await coreReportRequest(kind,{method:'PATCH',reportId:lease.id,body:{revision:lease.revision,leaseToken:lease.leaseToken,status:'failed',errorMessage:'诊断未完成，请重试。',...(payload?{payload}:{})}}).catch(()=>{});
   }
  };
  const background=options.background||((action:()=>Promise<void>,actor:string)=>withBackgroundOpencodeSlot(action,{taskType:'agent-debug',user:actor,label:`${kind}: ${executionId}`,displayOnly:kind==='skills-analysis',signal:abort.signal}));
  const job=Promise.resolve().then(()=>background(run,user)).catch(async()=>{
   await coreReportRequest(kind,{method:'PATCH',reportId:lease.id,body:{revision:lease.revision,leaseToken:lease.leaseToken,status:'failed',errorMessage:'诊断未能启动，请重试。'}}).catch(()=>{});
  }).finally(()=>{clearInterval(timer);jobs.delete(key);});
  jobs.set(key,job);
  if(isUsageEnabled())recordUsageEvent({user,featureKey:'trace',eventKey:kind==='agent-debug'?'trace.agent.debug':'trace.skills.analysis'});
  const row=publicRow(started,kind);
  return json(kind==='agent-debug'?{reportId:lease.id,row,status:'running',cached:false,progress:progress.writer.snapshot()}
   :{row,skillsAnalysis:{...running,runId:lease.id,progress:progress.writer.snapshot()},status:'running',cached:false},202);
 },options);}catch(cause){return compatibilityFailure(cause);}
}
