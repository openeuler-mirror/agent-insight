import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {getPreferredInsightDir} from '@/lib/agent-insight-paths';
import {runGeneralAgent,resolveGeneralAgentModel} from '@/lib/engine/general-agent/runner';
import {withBackgroundOpencodeSlot} from '@/lib/engine/general-agent/concurrency-limiter';
import {normalizeClaudeCodeInteractionsForStorage} from '@/lib/shared/interaction-content';
import {inferSubagentNamesFromInteractions} from '@/lib/engine/observability/subagent-inference';
import {recordUsageEvent} from '@/lib/usage-analytics/collector';
import {isUsageEnabled} from '@/lib/usage-analytics/config';
import {compatibilityContext,compatibilityFailure,compatibleRequest,type CompatibilityOptions} from './compat';
import {readTraceEvidence} from './evidence';
import {requestCore,readCoreBytes} from './server';
import {streamDiagnosisTurn} from './diagnosis-stream';
import {withCoreReports} from './reports';

type Actor=Awaited<ReturnType<typeof compatibilityContext>>;
interface DiagnosisHandle {request_key:string;fence:string;lease_owner:string|null;revision:string;state:string}
interface DiagnosisReply {
 session:{id:string};messages?:Array<{role:string;content:string}>;turn:DiagnosisHandle;
 duplicate:boolean;is_first_user_message:boolean;trace_id:string;opencode_session_id:string|null;
 workspace_key:string;assistant_message?:{content:string;state:string;opencodeSessionId:string|null};
}
interface PromptInput {
 workspaceDir:string;executionId:string;interactions:unknown[];brief:unknown;
 agentDebugContext:string;previousMessages:Array<{role:string;content:string}>;message:string;
}
interface DiagnosisOptions extends CompatibilityOptions {
 model?:typeof resolveGeneralAgentModel;
 prepare:(args:PromptInput)=>{query:string;system:string}|Promise<{query:string;system:string}>;
 reportContext:(executionId:string,interactions:unknown[])=>Promise<string>;
 workspace?:(key:string)=>string;
}
const error=(status:number,message:string)=>Object.assign(new Error(message),{status});
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function diagnosisWorkspace(key:string) {
 if(!/^diagnosis-[0-9a-f]{64}$/.test(key))throw error(503,'Invalid diagnosis workspace');
 const root=getPreferredInsightDir();
 const folders=[root,path.join(root,'agent_workspaces'),path.join(root,'agent_workspaces','core-diagnosis'),path.join(root,'agent_workspaces','core-diagnosis',key)];
 for(const folder of folders){
  fs.mkdirSync(folder,{recursive:true,mode:0o700});
  const info=fs.lstatSync(folder);if(info.isSymbolicLink()||!info.isDirectory())throw error(503,'Invalid diagnosis workspace');
 }
 const directory=folders.at(-1)!;fs.chmodSync(directory,0o700);fs.mkdirSync(path.join(directory,'.git'),{recursive:true,mode:0o700});
 return fs.realpathSync(directory);
}
async function operation(actor:Actor,action:string,body:Record<string,unknown>,options:CompatibilityOptions={}):Promise<DiagnosisReply> {
 const raw=JSON.stringify(body);
 for(let attempt=0;;attempt++) {
  try {
   const {data}=await requestCore('/v1/compat/fault/diagnosis/'+action+'?'+new URLSearchParams({workspace_id:actor.workspace}),
    {token:actor.token,method:'POST',body:raw,responseLimit:16*1024*1024+1024},options.fetcher||fetch);
   const value=data.value as DiagnosisReply;
   if(!value||!value.session||typeof value.session.id!=='string')throw error(503,'Invalid diagnosis response');
   return value;
  } catch(cause) {
   const status=cause instanceof Error&&'status'in cause?cause.status:undefined;
   if(attempt>=2||(status!==undefined&&status!==502&&status!==503))throw cause;
   await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
  }
 }
}
export function handleCoreDiagnosisSession(request:Request,options:CompatibilityOptions={}) {
 return compatibleRequest(request,'/v1/compat/fault/diagnosis/session',['executionId'],options);
}

export async function handleCoreDiagnosisStream(request:Request,options:DiagnosisOptions):Promise<Response> {
 let active:{actor:Actor;reply:DiagnosisReply}|undefined;
 try {
  const actor=await compatibilityContext(request,options);if(!actor.username)throw error(403,'Verified model identity required');
  const raw=await readCoreBytes(request.body,2*1024*1024);
  let body:Record<string,unknown>;
  try{body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw error(400,'Invalid JSON');}
  if(!body||typeof body!=='object'||Array.isArray(body))throw error(400,'JSON object required');
  const message=typeof(body.message??body.query)==='string'?String(body.message??body.query).trim():'';
  const executionId=typeof body.executionId==='string'?body.executionId.trim():'';
  if(!message||!executionId||executionId.length>512||message.includes('\0'))throw error(400,'Trace and message required');
  if(Buffer.byteLength(message,'utf8')>1024*1024)throw error(413,'Diagnosis message exceeds budget');
  if(body.sessionId!==undefined&&body.sessionId!==null&&(typeof body.sessionId!=='string'||!body.sessionId.trim()||body.sessionId.length>512))throw error(400,'Invalid continuation');
  const timeout=body.timeoutMs??300_000;
  if(typeof timeout!=='number'||!Number.isInteger(timeout)||timeout<1000||timeout>540_000)throw error(400,'Invalid diagnosis timeout');
  const suppliedKey=request.headers.get('idempotency-key');
  if(suppliedKey!==null&&!/^[\x21-\x7e]{1,128}$/.test(suppliedKey))throw error(400,'Invalid diagnosis request key');
  const requestKey=suppliedKey??randomUUID();const leaseOwner=randomUUID();
  const {evidence}=await readTraceEvidence(request,{traceRef:executionId},options);
  if(evidence.manifest.workspace_id!==actor.workspace)throw error(403,'Evidence workspace changed');
  const model=await (options.model??resolveGeneralAgentModel)(actor.username);
  const reply=await operation(actor,'begin',{executionId,request_key:requestKey,lease_owner:leaseOwner,message,evidence_hash:evidence.snapshot_hash,
   model_key:digest({user:actor.username,providerID:model.providerID,modelID:model.modelID,baseURL:model.baseURL,temperature:0.2,maxTokens:2400}),
   context_hash:digest({evidence:evidence.snapshot_hash,protocol:1}),
   ...(Object.prototype.hasOwnProperty.call(body,'sessionId')?{opencode_session_id:body.sessionId}:{}),},options);
  active={actor,reply};
  if(reply.trace_id!==evidence.manifest.trace_id)throw error(409,'Trace identity changed');
  const workspaceDir=(options.workspace??diagnosisWorkspace)(reply.workspace_key);
  if(reply.duplicate&&reply.turn.state==='streaming'&&reply.turn.lease_owner===leaseOwner)reply.duplicate=false;
  if(reply.duplicate) {
   if(reply.turn.state==='streaming')throw error(409,'Diagnosis already running');
   const ready={executionId,sessionId:reply.opencode_session_id,diagnosisSessionId:reply.session.id};
   const done=reply.turn.state==='done';const value=done?{sessionId:reply.assistant_message?.opencodeSessionId,diagnosisSessionId:reply.session.id,workspaceDir,output:reply.assistant_message?.content,stats:null}:{message:'该轮诊断已结束，请重新载入历史后发起新一轮。'};
   return new Response(`event: ready\ndata: ${JSON.stringify(ready)}\n\nevent: ${done?'done':'error'}\ndata: ${JSON.stringify(value)}\n\n`,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','X-Accel-Buffering':'no'}});
  }
  let interactions=evidence.session.interactions;
  if(evidence.execution.framework==='claudecode')interactions=normalizeClaudeCodeInteractionsForStorage(interactions as Parameters<typeof normalizeClaudeCodeInteractionsForStorage>[0]);
  interactions=inferSubagentNamesFromInteractions(interactions as Parameters<typeof inferSubagentNamesFromInteractions>[0]);
  const agentDebugContext=await withCoreReports(request,()=>options.reportContext(evidence.execution.id,interactions),options);
  const prompt=await options.prepare({workspaceDir,executionId:evidence.execution.id,interactions,brief:evidence.execution,agentDebugContext,previousMessages:reply.messages??[],message});
  const handle={session_id:reply.session.id,request_key:reply.turn.request_key,lease_owner:reply.turn.lease_owner,turn_fence:reply.turn.fence};
  let revision=reply.turn.revision;
  let upstream=reply.opencode_session_id;
  const indexed=new Map<string,Record<string,unknown>>();
  const renew=async()=>{await operation(actor,'renew',handle,options);};
  if(isUsageEnabled())recordUsageEvent({user:actor.username,featureKey:'fault',eventKey:reply.is_first_user_message?'fault.diagnosis.run':'fault.message.send'});
  return streamDiagnosisTurn({executionId,diagnosisSessionId:reply.session.id,sessionId:upstream,signal:request.signal,renew,
   checkpoint:async content=>{const saved=await operation(actor,'checkpoint',{...handle,expected_revision:revision,content},options);revision=saved.turn.revision;},
   finish:async terminal=>{
    if(terminal.state==='done'&&(!terminal.opencodeSessionId||!indexed.has(terminal.opencodeSessionId)))throw error(503,'Diagnostic Trace not indexed');
    const provider=terminal.opencodeSessionId??upstream;
    const saved=await operation(actor,'finish',{...handle,expected_revision:revision,content:terminal.content,state:terminal.state,error_code:terminal.errorCode,opencode_session_id:provider,trace_receipt:provider?indexed.get(provider):undefined},options);revision=saved.turn.revision;
   },
   execute:(handlers,signal)=>withBackgroundOpencodeSlot(async()=>{await renew();signal.throwIfAborted();return runGeneralAgent({user:actor.username!,query:prompt.query,system:prompt.system,sessionId:upstream??undefined,
    trustedWorkspaceDir:workspaceDir,trustedModel:model,sessionTitle:`fault-diagnosis · ${executionId}`,systemAgentName:'fault-diagnosis-agent',recordTraceAs:'fault-diagnosis-agent',tagSkill:'agent-debug-diagnosis',
    interactionPolicy:'auto-allow',agent:'build',handlers,cancelSignal:signal,timeoutMs:timeout,modelOptions:{temperature:0.2,maxTokens:2400},
    recordCoreTrace:async payload=>{
     await renew();
     const {data}=await requestCore('/v1/compat/observe/agent-traces?'+new URLSearchParams({workspace_id:actor.workspace}),{token:actor.token,method:'POST',body:JSON.stringify({...payload,context:{parent_trace_id:reply.trace_id,diagnosis_session_id:reply.session.id,request_key:handle.request_key,lease_owner:handle.lease_owner,turn_fence:handle.turn_fence}}),timeoutMs:295_000,responseLimit:1024*1024},options.fetcher||fetch);
     const receipt=data.value as Record<string,unknown>&{state?:string;task_id?:string};
     if(receipt?.state!=='indexed'||typeof receipt.task_id!=='string'||receipt.task_id!==payload.record.task_id)throw error(503,'Diagnostic Trace not indexed');
     indexed.set(receipt.task_id,receipt);upstream=receipt.task_id;
    },
   });},{taskType:'fault-diagnosis',user:actor.username!,label:`fault-diagnosis · ${executionId}`,displayOnly:true}),
  });
 } catch(cause) {
  if(active&&!active.reply.duplicate) {
   const {actor,reply}=active;
   await operation(actor,'finish',{session_id:reply.session.id,request_key:reply.turn.request_key,lease_owner:reply.turn.lease_owner,turn_fence:reply.turn.fence,expected_revision:reply.turn.revision,
    content:'错误: 诊断准备失败，请重试。',state:'failed',error_code:'preparation_failed',opencode_session_id:reply.opencode_session_id},options).catch(()=>{});
  }
  return compatibilityFailure(cause);
 }
}
