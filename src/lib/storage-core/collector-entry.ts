import {createHash,randomUUID} from 'node:crypto';
import {configuredCoreBackgroundActorForUser,configuredCoreBackgroundActors,type CoreBackgroundActor} from './compat';
import {resolveCoreCollectorIdentity,withCoreCollectorIdentity,collectorIdentityForOperation,collectorIdentityForBackgroundActor,getActiveCoreCollectorIdentity,type CoreCollectorIdentity} from './collector-identity';
import {beginCoreCollectorPreparation,captureDurableCoreCollectorPreparation,prepareDurableCoreCollectorPlan,sealCoreCollectorPlan,commitCoreCollectorPreparation,coreCollectorPreparationStatus,type DurableCollectorPreparation} from './collector-durable-preparation';
import {controllerHeaders} from './controller';
import {requestCore} from './server';
import {isDeletedOpencodeSessionId} from '@/lib/ingest/opencode-deleted-sessions';
import {isInProgressOpencodeSnapshot} from '@/lib/ingest/opencode-snapshot';
import {getDefaultIngestUser} from '@/lib/storage/data-service';
import {normalizeEndpointUrl} from '@/lib/infra/endpoint-resolve';
import {normalizeTraceClientMetadata} from '@/lib/reliability/trace-client';
import {clientIpFromRequest} from '@/lib/reliability/client-ip';
import {coreReadChanged,coreReadInvalidated,markCoreReadSideEffect} from './read-retry';

type Row=Record<string,any>;
export interface CoreCollectorWriteOptions {operationKey?:string;analysis?:boolean;analysisJob?:Row;channel?:string;receivedAt?:Date|null;sourceProof?:Row;}
const fail=(status:number,message:string)=>Object.assign(new Error(message),{status});
export const collectorHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function collectorFailure(error:unknown){const status=Number((error as Row)?.status)||503;return Response.json({error:status===401?'Collector authentication required':status===403?'Collector access denied':'Collector storage is not ready; retain the source and retry'},{status:[400,401,403,404,409,413,503].includes(status)?status:503});}
export async function resolveCollectorRequest(request:Request,operation:'snapshot'|'complete',data:Row={},authorizationKind:'collector'|'provider'='collector'){
 const supplied=request.headers.has('x-witty-api-key')||(authorizationKind!=='provider'&&request.headers.has('authorization'))||request.headers.has('x-agent-insight-client-id');
 if(supplied)return resolveCoreCollectorIdentity(request,{operation,framework:data.framework,clientId:data.clientId,authorizationKind});
 const username=getDefaultIngestUser();if(!username)throw fail(401,'A collector credential or explicit trusted default actor is required');
 const actor=await configuredCoreBackgroundActorForUser(username);return collectorIdentityForBackgroundActor(actor,{operation,framework:data.framework,authorizationKind});
}
export async function collectorPrivate(identity:CoreCollectorIdentity,action:string,payload:Row={}){
 return withCoreCollectorIdentity(identity,async(actor,options)=>{
  const body=JSON.stringify({action,...payload});
  for(let attempt=0;attempt<3;attempt++)try{
   const {data}=await requestCore('/v1/compat/collector-source?'+new URLSearchParams({workspace_id:actor.workspace}),{token:actor.token,method:'POST',body,headers:await controllerHeaders(actor,body,'collector-source/v1'),responseLimit:256*1024*1024,timeoutMs:65_000},options.fetcher||fetch);
   if(!Object.hasOwn(data,'value'))throw fail(502,'Invalid collector response');return data.value as any;
  }catch(error){if(attempt===2||[400,401,403,404,409,413].includes(Number((error as Row)?.status)))throw error;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}

 });
}
export async function waitCoreCollector(identity:CoreCollectorIdentity,receipt:DurableCollectorPreparation,deadline=Date.now()+60_000){
 let current=receipt;
 while(current.source_state!=='indexed'){
  if(current.source_state==='failed')throw fail(503,'Collector storage failed');
  if(Date.now()>=deadline)throw fail(503,'Collector graph is awaiting indexing');
  await new Promise(resolve=>setTimeout(resolve,50));current=await coreCollectorPreparationStatus(identity,current);
 }
 return current;
}
export async function writeCoreCollectorRecord(identity:CoreCollectorIdentity,record:Row,options:CoreCollectorWriteOptions={}){
 if(String(record.framework||'').toLowerCase()==='codex'&&String(record.upload_id||record.task_id||'').startsWith('pending:'))return {success:true,record:{...record,interactions:[]},receipt:null,plan:null,disposition:'pending'};
 if(record.threadOnly&&(!record.framework||!record.traceThread?.sourceThreadId)){const enabled=options.analysis!==false&&(options.channel||'upload')==='upload'&&await withCoreCollectorIdentity(identity,async()=>{const {getUserSettings}=await import('@/lib/storage/server-config');return (await getUserSettings(identity.username)).autoEvaluationEnabled??true;});return {success:true,record:{...record,interactions:[]},receipt:null,plan:{skipped:true,collector_entry:{analysis_requested:enabled}},disposition:'no_effect'};}
 const operationKey=options.operationKey||'snapshot:'+collectorHash(record);const requested={data:record,_collector_save_mode:(options.channel||'upload')==='upload'?'quick':'original',...(options.receivedAt!==undefined?{_collector_received_at:options.receivedAt===null?null:options.receivedAt.toISOString()}:{}),...(options.analysisJob?{_collector_job:options.analysisJob.event_id}:{}),...(options.sourceProof?{source_proof:options.sourceProof}:{})};
 const task=record.task_id||record.upload_id||'collector-'+collectorHash(requested).slice(0,40);const execution=record.upload_id||task;
 for(let pass=0;pass<8;pass++){
  let receipt=await beginCoreCollectorPreparation(identity,{operation_key:operationKey,task_id:task,execution_id:execution,framework:record.framework??null,...(record.trace_started_at!=null?{started_at_ms:new Date(record.trace_started_at).getTime()}:{})},requested);
  if(options.analysisJob&&receipt.reservation.operation_request?._collector_job!==options.analysisJob.event_id)throw fail(409,'Collector analysis was superseded');
  const selected=collectorIdentityForOperation(identity,receipt.reservation.operation==='complete'?'complete':'snapshot');
  receipt=await captureDurableCoreCollectorPreparation(selected,receipt);
  if(receipt.plan_json===null&&receipt.source_state==='reserved'){
   const {prepareCoreCollectorSnapshot,prepareCoreCollectorCompletion,prepareCoreCollectorThread}=await import('./collector-preparation');const frozen=JSON.parse(receipt.capture_json!);
   const plan:Row=receipt.reservation.operation==='complete'?prepareCoreCollectorCompletion(receipt.reservation,frozen):receipt.reservation.operation==='thread_only'?prepareCoreCollectorThread(receipt.reservation,frozen):await prepareCoreCollectorSnapshot(receipt.reservation,frozen);
   const raw=receipt.reservation.operation_request.data??receipt.reservation.operation_request;
   if(raw.framework==='opencode'&&raw.opencode_cli_completed&&plan.snapshot?.session){plan.snapshot.session.endTime=new Date(receipt.reservation.received_at_ms).toISOString();}
   const analysis=options.analysis!==false&&receipt.reservation.operation!=='complete'&&(plan.analysis?.needs_internal_judgment===true||(options.channel||'upload')==='upload'&&!isInProgressOpencodeSnapshot(raw)&&frozen.settings.autoEvaluationEnabled);
   plan.collector_entry={channel:options.channel||'upload',analysis_requested:analysis,run_upload_analysis:analysis&&(options.channel||'upload')==='upload',...(raw.framework==='opencode'&&raw.opencode_cli_completed?{cli_completed_at_ms:receipt.reservation.received_at_ms}:{}),debounce_ms:analysis?Math.max(0,Math.min(Number(process.env.UPLOAD_ASYNC_DEBOUNCE_MS)||15000,60000)):0,...(options.analysisJob?{analysis_job:options.analysisJob}:{})};
   receipt=await sealCoreCollectorPlan(selected,receipt,plan);
  }
  if(receipt.plan_json!==null)receipt=await commitCoreCollectorPreparation(selected,receipt,options.analysisJob);
  receipt=await waitCoreCollector(selected,receipt);
  if(receipt.operation_key!==operationKey)continue;
  const plan=receipt.plan_json?JSON.parse(receipt.plan_json):null;
  if(plan?.collector_entry?.analysis_requested||plan?.post_hooks?.length){const {kickCoreCollectorWorker}=await import('./collector-worker');kickCoreCollectorWorker(identity);}
  return {success:true,record:plan?.record||(receipt.scope_kind==='thread'?{...record,interactions:[],traceThreadId:plan?.thread?.thread?.id}:{...record,task_id:receipt.reservation.task_id,upload_id:receipt.reservation.execution_id}),receipt,plan};
 }
 throw fail(503,'Collector is still completing an earlier operation');
}
export async function writeCoreCollectorForActor(actor:CoreBackgroundActor,record:Row,options:CoreCollectorWriteOptions={}){
 const identity=await collectorIdentityForBackgroundActor(actor,{operation:'snapshot',framework:record.framework});return writeCoreCollectorRecord(identity,{...record,user:actor.username},options);
}
export async function completeCoreCollector(identity:CoreCollectorIdentity,body:Row,operationKey?:string,analysisJob?:Row){
 identity=collectorIdentityForOperation(identity,'complete');
 const task=String(body.task_id||body.session_id||body.sessionID||'').trim();if(!task)throw fail(400,'task_id is required');
 const parsed=body.completed_at?new Date(body.completed_at):null;const completed=parsed&&!Number.isNaN(parsed.getTime())?parsed.getTime():null;
 const request={task_id:task,...(completed!==null?{completed_at:new Date(completed).toISOString()}:{}),...(analysisJob?{_collector_job:analysisJob.event_id}:{})};const key=operationKey||'complete:'+collectorHash(request);
 for(let pass=0;pass<8;pass++){
  let receipt=await beginCoreCollectorPreparation(identity,{operation_key:key,task_id:task,execution_id:task,...(completed!==null?{completion_at_ms:completed}:{})},request);
  const selected=collectorIdentityForOperation(identity,receipt.reservation.operation==='complete'?'complete':'snapshot');receipt=await captureDurableCoreCollectorPreparation(selected,receipt);
  if(analysisJob&&receipt.plan_json===null&&receipt.reservation.operation==='complete'){
   const {prepareCoreCollectorCompletion}=await import('./collector-preparation');const plan:any=prepareCoreCollectorCompletion(receipt.reservation,JSON.parse(receipt.capture_json!));plan.collector_entry={analysis_requested:false,analysis_job:analysisJob};receipt=await sealCoreCollectorPlan(selected,receipt,plan);
  }else receipt=await prepareDurableCoreCollectorPlan(selected,receipt);
  if(receipt.plan_json)receipt=await commitCoreCollectorPreparation(selected,receipt,analysisJob);receipt=await waitCoreCollector(selected,receipt);
  if(receipt.operation_key===key)return {success:true,task_id:task,endTime:new Date(receipt.reservation.completed_at_ms!).toISOString()};
 }
 throw fail(503,'Collector completion is pending');
}
export async function mutateCoreCollectorSession(identity:CoreCollectorIdentity,taskId:string,changes:Row,mode:'create'|'patch'|'append'='patch',operationKey:string=randomUUID(),fence?:Row){
 const mutationDeadline=Date.now()+60000;
 for(let attempt=0;Date.now()<mutationDeadline;attempt++){
  try{
  const current=mode==='create'?null:await collectorPrivate(identity,'owned_session',{task_id:taskId});
  let session=current?.session_json?JSON.parse(current.session_json):null;const payload:Row={operation_key:operationKey,task_id:taskId,legacy_username:identity.username,mode,changes,...(current?{expected_revision:fence?.source_revision??current.source_revision}:{}),...(fence?{expected_annotation_revision:fence.annotation_revision}:{})};
  if(session){session=structuredClone(session);if(mode==='append')session.interactions.push(changes.interaction);else Object.assign(session,changes);session.user=identity.username;if(!Object.values(changes).includes('server'))payload.session_json=JSON.stringify(session);}
   const result=await collectorPrivate(identity,'mutate_session',payload);
   const deadline=Date.now()+60_000;while(result.state!=='indexed'){
    if(Date.now()>=deadline)throw fail(503,'Session is awaiting indexing');
    const status=await collectorPrivate(identity,'status',{task_id:taskId,operation_key:operationKey});if(status.state==='indexed')break;if(status.state==='failed')throw fail(503,'Session publication failed');await new Promise(resolve=>setTimeout(resolve,50));
   }
   return result.session as Row;
  }catch(error){if(fence||![409,503].includes(Number((error as Row).status))||Date.now()>=mutationDeadline)throw error;await new Promise(resolve=>setTimeout(resolve,50));}
 }
 throw fail(503,'Session mutation remains pending');
}
export async function patchCoreCollectorSession(request:Request,taskId:string,changes:Row){const identity=getActiveCoreCollectorIdentity()||await resolveCollectorRequest(request,'snapshot');const {getCoreSessionScope}=await import('./session-source');const source=getCoreSessionScope()?.values.get(taskId);return mutateCoreCollectorSession(identity,taskId,changes,'patch',randomUUID(),source);}
export async function handleCoreCollectorUpload(request:Request){
 try{
  const body=await request.json();const data=structuredClone(body?.data??body);if(!data||typeof data!=='object'||Array.isArray(data))throw fail(400,'Collector object required');
  const identity=await resolveCollectorRequest(request,'snapshot',data);
  data.user=identity.username;
  if(String(data.framework||'').toLowerCase()==='codex'&&String(data.upload_id||data.task_id||'').startsWith('pending:'))return Response.json({success:true,upload_id:data.task_id,auto_evaluation:false,background_analysis:false});
  if(data.framework==='opencode'&&data.task_id&&isDeletedOpencodeSessionId(String(data.task_id)))return Response.json({success:true,skipped:true,reason:'deleted-opencode-session'});
  if(data.endpoint)data.endpoint=normalizeEndpointUrl(data.endpoint)??undefined;
  if(data.framework==='opencode'){const metadata=normalizeTraceClientMetadata(data);Object.assign(data,metadata,{clientId:identity.clientId,observedIp:clientIpFromRequest(request,{allowDirectConnection:true,clientHostName:metadata.hostName})});}
  if(data.task_id){const {getInternalAgentTag}=await import('@/lib/internal-agent-tag');let tag=getInternalAgentTag(String(data.task_id)) as Row|undefined;
   if(!tag){const row=await withCoreCollectorIdentity(identity,async()=>{const {controlRepositoryRequest}=await import('./control-repository');return (await controlRepositoryRequest('collector_agent_tag',{opencode_session_id:String(data.task_id)})).tag;});if(row?.agentName)tag={agentName:row.agentName,skill:row.agentTraceSkill,user:row.user};}
   if(tag?.user&&tag.user!==identity.username)throw fail(403,'Internal collector owner differs');
   if(tag&&(!tag.user||tag.user===identity.username)){data.agentName=tag.agentName;if(tag.agentId)data.agentId=tag.agentId;if(tag.skill)data.skill=tag.skill;if(tag.displayQuery)data.query=tag.displayQuery;}
  }
  const result=await writeCoreCollectorRecord(identity,data,{operationKey:request.headers.get('idempotency-key')||undefined});
  if(isInProgressOpencodeSnapshot(data))return Response.json({success:true,message:'In-progress snapshot saved; analysis deferred until session completes',upload_id:result.record.task_id,auto_evaluation:false,background_analysis:false,in_progress:true});
  const analysis=result.plan?.collector_entry?.analysis_requested===true;
  return Response.json({success:true,message:analysis?'Upload received and analyzing in background':'Upload received, background analysis disabled',upload_id:result.record.task_id,auto_evaluation:false,background_analysis:analysis});
 }catch(error){return collectorFailure(error);}
}
export async function handleCoreCollectorComplete(request:Request){try{const body=await request.json().catch(()=>({}));const identity=await resolveCollectorRequest(request,'complete',body);return Response.json(await completeCoreCollector(identity,body,request.headers.get('idempotency-key')||undefined));}catch(error){return collectorFailure(error);}}
export async function runCoreSessionModel<T>(request:Request,taskId:string,action:()=>Promise<T>):Promise<T>{
 const {getCoreSessionScope,readCoreStoredSession}=await import('./session-source');const scope=getCoreSessionScope();if(!scope)throw fail(403,'Session model scope required');
 const before=scope.values.get(taskId);const source=await readCoreStoredSession(taskId,true);if(before&&(!source||before.trace_id!==source.source.trace_id||before.owner_principal_id!==source.source.owner_principal_id||before.identity_hash!==source.source.identity_hash))throw coreReadInvalidated('Session identity changed before model execution');if(before&&source&&(before.source_revision!==source.source.source_revision||before.annotation_revision!==source.source.annotation_revision)){if(before.identity_hash)throw coreReadChanged('Session changed before model execution');throw coreReadInvalidated('Session changed without a stable identity proof');}if(!source?.source.can_execute||source.source.owner_principal_id!==scope.actor.principal)throw fail(403,'Session owner execute capability required');
 let identity:CoreCollectorIdentity;
 try{identity=await resolveCollectorRequest(request,'snapshot');}catch(error){
  if(!/^Bearer session_/.test(request.headers.get('authorization')||''))throw error;
  let selected:CoreCollectorIdentity|undefined;const configured=await configuredCoreBackgroundActors({},true);for(const actor of configured.actors){if(actor.username!==source.session!.user||actor.principal!==scope.actor.principal||actor.workspace!==scope.actor.workspace)continue;try{const candidate=await collectorIdentityForBackgroundActor(actor,{operation:'snapshot'});await collectorPrivate(candidate,'model_scope',{task_id:taskId});selected=candidate;break;}catch(error){if(![401,403].includes(Number((error as Row)?.status)))throw error;}}if(!selected)throw fail(403,'Verified Session owner executor required');identity=selected;
 }
 return withCoreCollectorIdentity(identity,async()=>{await collectorPrivate(identity,'model_scope',{task_id:taskId});markCoreReadSideEffect();return action();});
}
