import {createHash} from 'node:crypto';
import {
  prepareExecutionRecordState, prepareExecutionSession, prepareExecutionWrite, prepareExecutionRouting,
  prepareTraceThread, prepareSubagentExecutions, prepareUploadQuickData, computeOwnSkills,
  readConfig, readEvaluationResults, fillConfigKeyActionsFromParsedFlows, findBestRoutingConfig,
  findBestOutcomeConfig, buildRecordEvaluationSnapshots, allowsSnapshotShrinkForFramework,
  supportsSubagentExecutionDerivation, resolveExecutionPreparationFramework, getRoutingExpectedSkills, prepareExecutionSkills, type ExecutionRecord, type ConfigItem, type InvokedSkill,
} from '@/lib/storage/data-service';
import {db,prismaRaw} from '@/lib/storage/prisma';
import {getUserSettings,getActiveConfig} from '@/lib/storage/server-config';
import {freezeModelSelection} from './frozen-model';
import {chooseExecutionLabel} from '@/lib/engine/evaluation/label-utils';
import {extractObservedAgentRegistrations,getFrameworkPrimaryAgentName} from '@/lib/engine/observability/agent-registration';
import {computeCallStats} from '@/lib/fleet/call-stats';
import {isInternalSystemAgentTrace} from '@/lib/system-agent-names';
import {isInProgressOpencodeSnapshot} from '@/lib/ingest/opencode-snapshot';
import {isVerifiedCoreCollectorIdentity,withCoreCollectorIdentity,type CoreCollectorIdentity} from './collector-identity';

type Row=Record<string,any>;
interface FrozenSkill extends Row {id:string;name:string;activeVersion:number|null;versions:Array<{version:number;content:string}>}
export interface CollectorSourceReservation {
 trace_id:string;task_id:string;execution_id:string;operation_key:string;operation:'snapshot'|'complete';state:string;
 input_hash:string;base_revision:string;source_revision:string;received_at_ms:number;completed_at_ms:number|null;
 operation_request:Row;provenance:{legacy_username:string;verified_client_id?:string|null;framework?:string|null};
 snapshot:{execution:Row;session:Row|null}|null;
}
export interface CollectorThreadReservation extends Omit<CollectorSourceReservation,'trace_id'|'task_id'|'execution_id'|'operation'> {trace_id:null;task_id:null;execution_id:null;operation:'thread_only'}
export type CollectorReservation=CollectorSourceReservation|CollectorThreadReservation;
interface CollectorBinding {trace_id:string|null;task_id:string|null;execution_id:string|null;operation_key:string;input_hash:string;base_revision:string;request_hash:string;reservation_hash:string}
export interface FrozenCollectorPreparation {
 version:1;actor:{principal:string;workspace:string;username:string};binding:CollectorBinding;
 configs:ConfigItem[];skills:FrozenSkill[];active_skill_versions:Record<string,number>;evaluation_results:Record<string,string>;
 settings:{autoEvaluationEnabled:boolean};allow_snapshot_shrink:boolean;execution_match:Row|null;thread_id:string|null;previous_session?:Row|null;
 model_selection?:ReturnType<typeof freezeModelSelection>;
 routing_skills?:Array<{name:string;activeVersion:number|null}>;
 registered_agents?:Array<{id:string;platform:string;name:string}>;
 parsed_flows?:Array<{skillId:string;version:number;flowJson:string|null}>;
 graph_context?:Row;
}
const bindingKeys=['trace_id','task_id','execution_id','operation_key','input_hash','base_revision'] as const;
const failure=(status:number,message:string)=>Object.assign(new Error(message),{status});
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Row)[key])).join(',')+'}';
 return JSON.stringify(value);
}
export function collectorPreparationBinding(value:CollectorReservation):CollectorBinding {
 return {...Object.fromEntries(bindingKeys.map(key=>[key,value[key]])),request_hash:createHash('sha256').update(canonical(value.operation_request)).digest('hex'),reservation_hash:createHash('sha256').update(canonical({received_at_ms:value.received_at_ms,completed_at_ms:value.completed_at_ms,provenance:value.provenance,snapshot:value.snapshot})).digest('hex')} as unknown as CollectorBinding;
}
const binding=collectorPreparationBinding;
function jsonClone<T>(value:T):T{return JSON.parse(JSON.stringify(value));}
function check(value:CollectorReservation,frozen:FrozenCollectorPreparation,operation:CollectorReservation['operation']='snapshot'){
 if(frozen.version!==1||!/^\d+$/.test(value.base_revision)||!Number.isSafeInteger(value.received_at_ms)||value.received_at_ms<0)throw failure(400,'Invalid collector preparation');
 if(!frozen.actor.principal||!frozen.actor.workspace||frozen.actor.username!==value.provenance.legacy_username)throw failure(403,'Collector preparation owner differs');
 const current=binding(value);
 if(bindingKeys.some(key=>value[key]!==frozen.binding[key])||frozen.binding.request_hash!==current.request_hash||frozen.binding.reservation_hash!==current.reservation_hash)throw failure(409,'Collector preparation source changed');
 if(value.state!=='reserved'||value.operation!==operation)throw failure(409,'Collector source operation is not reserved');
 if(value.snapshot&&(value.snapshot.execution.id!==value.execution_id||value.snapshot.execution.taskId!==value.task_id))throw failure(409,'Collector previous snapshot identity differs');
}
function previousExecution(value:Row|null|undefined):Row|undefined{
 if(!value)return undefined;
 return {...value,timestamp:value.timestamp?new Date(value.timestamp):undefined,
  ...Object.fromEntries(['skills','invokedSkills','observedAgents'].map(key=>[key,Array.isArray(value[key])?JSON.stringify(value[key]):value[key]]))};
}
function previousSession(value:Row|null|undefined):Row|undefined{
 if(!value)return undefined;
 return {...value,interactions:typeof value.interactions==='string'?value.interactions:JSON.stringify(value.interactions),
  ...(Array.isArray(value.langfuseTraceNodes)?{langfuseTraceNodes:JSON.stringify(value.langfuseTraceNodes)}:{})};
}
function pinnedSkills(skills:InvokedSkill[],frozen:FrozenCollectorPreparation):InvokedSkill[]{
 return skills.map(skill=>skill.version!=null?{...skill}:{name:skill.name,version:typeof frozen.active_skill_versions[skill.name]==='number'?frozen.active_skill_versions[skill.name]:null});
}
const portableKeys=['id','taskId','query','framework','tokens','cost','latency','toolCallCount','llmCallCount','inputTokens','outputTokens','toolCallErrorCount','cacheReadInputTokens','cacheCreationInputTokens','maxSingleCallTokens','reasoningTokens','timestamp','model','endpoint','agentName','finalResult','skill','skillVersion','label','parentExecutionId','rootExecutionId','agentSessionId','subagentType','subagentName'] as const;
function portableExecution(fields:Row,previous?:Row):Row{
 const merged={...previous,...Object.fromEntries(Object.entries(fields).filter(([,value])=>value!==undefined))};
 const result:Row=Object.fromEntries(portableKeys.map(key=>[key,merged[key]??null]));
 for(const key of ['skills','invokedSkills','observedAgents'])result[key]=typeof merged[key]==='string'?JSON.parse(merged[key]):merged[key]??[];
 result.isSubagent=merged.isSubagent??false;
 for(const key of ['user','agentId','clientId','hostIp','hostName','observedIp','sourceExecutionId','sourceKind','executionStatus','traceThreadId','lastIngestedAt','isSkillCorrect','isAnswerCorrect','answerScore','skillScore','judgmentReason','failures','skillIssues','skillTriggerRate','callStats'])result[key]=merged[key]??null;
 return jsonClone(result);
}
function portableSession(value:Row|null):Row|null{
 if(!value)return null;
 return jsonClone({taskId:value.taskId,label:value.label??null,query:value.query??null,startTime:value.startTime,endTime:value.endTime??null,interactions:value.interactions,model:value.model??null,
  user:value.user??null,...(value.langfuseTraceNodes!=null?{langfuseTraceNodes:value.langfuseTraceNodes}:{})});
}

export async function captureCoreCollectorPreparation(identity:CoreCollectorIdentity,reservation:CollectorReservation,projection:{previousSession?:Row|null;executionMatch?:Row|null;threadId?:string|null;graphContext?:(input:{children:Row[];thread:Row|null;sweep:boolean})=>Promise<Row>}={}):Promise<FrozenCollectorPreparation>{
 if(!isVerifiedCoreCollectorIdentity(identity))throw failure(403,'Verified collector identity required');
 return withCoreCollectorIdentity(identity,async actor=>{
  if(actor.username!==reservation.provenance.legacy_username||identity.operation!==(reservation.operation==='thread_only'?'snapshot':reservation.operation))throw failure(403,'Collector preparation owner differs');
  const username=actor.username;
  const frozen:FrozenCollectorPreparation={version:1,actor:{principal:actor.principal,workspace:actor.workspace,username},binding:binding(reservation),configs:[],skills:[],active_skill_versions:{},evaluation_results:{},settings:{autoEvaluationEnabled:false},allow_snapshot_shrink:false,execution_match:jsonClone(projection.executionMatch??null),thread_id:projection.threadId??null,previous_session:jsonClone(projection.previousSession??null)};
  check(reservation,frozen,reservation.operation);
  if(reservation.operation==='complete'){await identity.revalidate();return frozen;}
  if(reservation.operation==='thread_only'){
   const raw=reservation.operation_request.data??reservation.operation_request;
   if(!raw.threadOnly||!raw.framework||!raw.traceThread?.sourceThreadId)throw failure(400,'Thread-only collector input required');
   frozen.thread_id=projection.threadId??`collector-thread:${createHash('sha256').update([actor.workspace,actor.principal,raw.framework,raw.traceThread.sourceThreadId].join('\0')).digest('hex')}`;
   if(projection.graphContext){frozen.graph_context=await projection.graphContext({children:[],thread:{framework:raw.framework,source_thread_id:raw.traceThread.sourceThreadId},sweep:false});frozen.thread_id=frozen.graph_context.thread_id??frozen.thread_id;}
   await identity.revalidate();return jsonClone(frozen);
  }
  const raw=reservation.operation_request.data??reservation.operation_request;
  const data:ExecutionRecord={...structuredClone(raw),task_id:reservation.task_id,upload_id:reservation.execution_id,user:username,clientId:reservation.provenance.verified_client_id??undefined};
  const thread=raw.traceThread;
  frozen.thread_id=thread?.sourceThreadId&&raw.framework ? projection.threadId??`collector-thread:${createHash('sha256').update([actor.workspace,actor.principal,raw.framework,thread.sourceThreadId].join('\0')).digest('hex')}` : reservation.snapshot?.execution.traceThreadId??projection.threadId??null;
  frozen.allow_snapshot_shrink=allowsSnapshotShrinkForFramework(resolveExecutionPreparationFramework(data,reservation.snapshot?.execution));
  if(data.threadOnly){await identity.revalidate();return jsonClone(frozen);}
  const loaded=new Map<string,Row|null>();
  let directory:Array<{id:string;name:string;activeVersion:number|null}>|undefined;
  const lookup=async(name:string)=>{
   const key=name.toLowerCase();
   if(!loaded.has(key)){
    directory??=await prismaRaw.skill.findMany({where:{user:username},select:{id:true,name:true,activeVersion:true}});
    const selected=directory!.find(skill=>skill.name.toLowerCase()===key);
    const versions=selected?await prismaRaw.skillVersion.findMany({where:{skillId:selected.id},select:{version:true},orderBy:{version:'desc'}}):[];
    loaded.set(key,selected?{...selected,versions}:null);
   }
   return loaded.get(key) as any;
  };
  const {quickData}=await prepareUploadQuickData(data,username,lookup);
  const state=prepareExecutionRecordState({data:quickData,recordId:reservation.execution_id,existingExecution:previousExecution(reservation.snapshot?.execution),existingSession:previousSession(reservation.snapshot?.session??frozen.previous_session),defaultTimestamp:new Date(reservation.received_at_ms).toISOString(),allowSnapshotShrink:frozen.allow_snapshot_shrink});
  const configs=await readConfig(username);
  const routing=await findBestRoutingConfig(configs,state.targetRecord.query,username),outcome=findBestOutcomeConfig(configs,state.targetRecord);
  frozen.configs=jsonClone(configs.filter(config=>config.id===routing?.id||config.id===outcome?.id));
  const routingNames=getRoutingExpectedSkills(routing).map(expected=>expected.skill);
  frozen.routing_skills=routingNames.length?await prismaRaw.skill.findMany({where:{user:username,name:{in:routingNames}},select:{name:true,activeVersion:true}}):[];
  const related=new Map<string,Set<number>>();
  const add=(name:string|undefined|null,version?:number|null)=>{if(!name)return;const key=name.toLowerCase();if(!related.has(key))related.set(key,new Set());if(typeof version==='number')related.get(key)!.add(version);};
  add(state.targetRecord.skill,state.targetRecord.skill_version);
  const own=state.explicitSkillVersionRewrite?state.targetRecord.invokedSkills??[]:state.mergedInteractionsForSession?.length?computeOwnSkills(state.targetRecord.framework,state.mergedInteractionsForSession):state.targetRecord.invokedSkills??[];
  const childPlan=!state.skipped&&supportsSubagentExecutionDerivation(state.targetRecord.framework)?prepareSubagentExecutions({parentExecutionId:reservation.execution_id,parentTaskId:reservation.task_id,parentFramework:state.targetRecord.framework,parentUser:username,interactions:state.mergedInteractionsForSession??[]},new Date(reservation.received_at_ms).toISOString()):{children:[],sweep:false};
  const children=childPlan.children;
  const invoked=[...own,...children.flatMap(child=>child.skills)] as InvokedSkill[];
  for(const skill of invoked)add(skill.name,skill.version);
  for(const config of [routing,outcome])if(config){add(config.skill,config.skillVersion);for(const expected of config.expectedSkills??[])add(expected.skill,expected.version);}
  frozen.parsed_flows=[];
  if(outcome)await fillConfigKeyActionsFromParsedFlows(structuredClone(outcome),username,{findSkill:lookup,findParsedFlow:async(skillId:string,version:number,owner:string|null)=>{
   const flow=await db.findParsedFlow(skillId,version,owner);if(flow)frozen.parsed_flows!.push({skillId,version,flowJson:flow.flowJson});return flow;
  }});
  for(const name of related.keys())await lookup(name);
  for(const [key,skill] of loaded){
   if(!skill)continue;
   const wanted=related.get(key)??new Set<number>();
   if(typeof skill.activeVersion==='number')wanted.add(skill.activeVersion);
   if(!skill.versions?.some((version:Row)=>version.version===skill.activeVersion)&&skill.versions?.length)wanted.add(skill.versions[0].version);
   const selectedVersions=(skill.versions??[]).filter((version:Row)=>wanted.has(version.version)).map((version:Row)=>version.version);
   const versions=selectedVersions.length?await prismaRaw.skillVersion.findMany({where:{skillId:skill.id,version:{in:selectedVersions}},select:{version:true,content:true},orderBy:{version:'desc'}}):[];
   frozen.skills.push({id:skill.id,name:skill.name,activeVersion:skill.activeVersion,versions});
  }
  const needVersions=[...new Set(invoked.filter(skill=>skill.version==null).map(skill=>skill.name))];
  if(needVersions.length){
   const rows=await prismaRaw.skill.findMany({where:{name:{in:needVersions},OR:[{user:username},{user:null}]},select:{name:true,activeVersion:true}});
   frozen.active_skill_versions=Object.fromEntries(rows.filter(skill=>typeof skill.activeVersion==='number').map(skill=>[skill.name,skill.activeVersion as number]));
  }
  const settings=await getUserSettings(username);frozen.settings={autoEvaluationEnabled:settings.autoEvaluationEnabled??true};
  frozen.model_selection=frozen.settings.autoEvaluationEnabled&&!isInProgressOpencodeSnapshot(data)?freezeModelSelection(await getActiveConfig(username)):null;
  const scoreName=state.targetRecord.skills?.[0];const scores=scoreName?readEvaluationResults():{};frozen.evaluation_results=scoreName&&scores[scoreName]!==undefined?{[scoreName]:scores[scoreName]}:{};
  const agentName=state.targetRecord.agentName||getFrameworkPrimaryAgentName(state.targetRecord.framework);
  const names=extractObservedAgentRegistrations(state.mergedInteractionsForSession,agentName).map(agent=>agent.name);
  frozen.registered_agents=state.targetRecord.framework&&names.length?await prismaRaw.registeredAgent.findMany({where:{user:username,platform:state.targetRecord.framework,name:{in:names}},select:{id:true,platform:true,name:true}}):[];
  if(projection.graphContext){
   const pending=String(data.framework||'').toLowerCase()==='codex'&&reservation.execution_id.startsWith('pending:');
   frozen.graph_context=await projection.graphContext({children:pending?[]:children.map(child=>({execution_id:child.execution.id,task_id:child.execution.taskId,started_at_ms:new Date(child.execution.timestamp).getTime()})),thread:!pending&&raw.traceThread?.sourceThreadId&&raw.framework?{framework:raw.framework,source_thread_id:raw.traceThread.sourceThreadId}:null,sweep:pending?false:childPlan.sweep});
   frozen.thread_id=frozen.graph_context.thread_id??frozen.thread_id;
  }
  check(reservation,frozen);await identity.revalidate();return jsonClone(frozen);
 });
}

export async function prepareCoreCollectorSnapshot(reservation:CollectorReservation,frozen:FrozenCollectorPreparation){
 if(reservation.operation!=='snapshot')throw failure(400,'Collector snapshot reservation required');
 check(reservation,frozen);
 const original=reservation.operation_request.data??reservation.operation_request;
 const data:ExecutionRecord={...structuredClone(original),task_id:reservation.task_id,upload_id:reservation.execution_id,user:frozen.actor.username,
  clientId:reservation.provenance.verified_client_id??undefined};
 const timestamp=new Date(reservation.received_at_ms).toISOString();

 if(String(data.framework||'').toLowerCase()==='codex'&&reservation.execution_id.startsWith('pending:'))return {binding:binding(reservation),disposition:'pending_parent',skipped:true,snapshot:null,children:[],thread:null,post_hooks:[],background_analysis:false};
 if(data.threadOnly){
  const thread=prepareTraceThread({data,threadId:frozen.thread_id??undefined});
  return jsonClone({binding:binding(reservation),disposition:'thread_only',skipped:false,snapshot:null,children:[],thread,post_hooks:thread?[{kind:'reconcile_trace_thread',threadId:frozen.thread_id}]:[],background_analysis:false});
 }

 const findSkill=async(name:string)=>frozen.skills.find(skill=>skill.name.toLowerCase()===name.toLowerCase()) as any;
 const {quickData,normalized}=await prepareUploadQuickData(data,frozen.actor.username,findSkill);
 const canonicalSession=reservation.snapshot?.session??frozen.previous_session;
 const old=previousExecution(reservation.snapshot?.execution),oldSession=previousSession(canonicalSession);
 const state=prepareExecutionRecordState({data:quickData,recordId:reservation.execution_id,existingExecution:old,existingSession:oldSession,defaultTimestamp:timestamp,allowSnapshotShrink:frozen.allow_snapshot_shrink});
 if(state.skipped)return {binding:binding(reservation),skipped:true,snapshot:jsonClone(reservation.snapshot),children:[],thread:prepareTraceThread({data,recordId:reservation.execution_id,threadId:frozen.thread_id??undefined}),post_hooks:[],background_analysis:false};
 let record=state.targetRecord;
 const configs=structuredClone(frozen.configs);
 const routing=await findBestRoutingConfig(configs,record.query,frozen.actor.username);
 const outcome=findBestOutcomeConfig(configs,record);
 const configUpdates:Row[]=[];
 if(outcome){
  const expectedConfig=structuredClone(outcome);
  const before=JSON.stringify(outcome.key_actions);
  await fillConfigKeyActionsFromParsedFlows(outcome,frozen.actor.username,{findSkill,findParsedFlow:async(skillId:string,version:number)=>frozen.parsed_flows?.find(flow=>flow.skillId===skillId&&flow.version===version) as any});
  if(JSON.stringify(outcome.key_actions)!==before)configUpdates.push({id:outcome.id,expected_config:expectedConfig,keyActions:JSON.stringify(outcome.key_actions),extractedKeyActions:JSON.stringify(outcome.extractedKeyActions)});
 }
 record=prepareExecutionRouting(record,routing,frozen.routing_skills??frozen.skills);
 record.answer_score=null;record.is_answer_correct=false;record.judgment_reason='结果评估中...';
 record=await buildRecordEvaluationSnapshots(record,configs,frozen.actor.username,frozen.routing_skills??frozen.skills);
 record.execution_match=structuredClone(frozen.execution_match);
 const score=Array.isArray(record.skills)&&record.skills.length?frozen.evaluation_results[record.skills[0]]:undefined;
 if(score)record.skill_score=parseFloat(score);
 record.label=chooseExecutionLabel({existingLabel:state.existingRecord?.label,incomingLabel:state.data.label,skill:record.skill,skillVersion:record.skill_version??null});
 const thread=prepareTraceThread({data,recordId:reservation.execution_id,threadId:frozen.thread_id??undefined});
 if(thread)record.traceThreadId=frozen.thread_id??undefined;
 const frameworkAgent=getFrameworkPrimaryAgentName(record.framework),agentName=record.agentName||frameworkAgent;
 const registered=frozen.registered_agents?.find(agent=>agent.platform===record.framework&&agent.name===agentName);
 const fields:Row=prepareExecutionWrite({record,recordId:reservation.execution_id,existingExecution:old,agentId:registered?.id,receivedAt:new Date(reservation.received_at_ms),interactions:state.mergedInteractionsForSession,defaultTimestamp:timestamp});
 const own=state.explicitSkillVersionRewrite?record.invokedSkills??[]:Array.isArray(state.mergedInteractionsForSession)&&state.mergedInteractionsForSession.length?computeOwnSkills(record.framework,state.mergedInteractionsForSession):record.invokedSkills??[];
 const rootSkills=pinnedSkills(own.map(skill=>skill.name===record.skill&&skill.version==null&&typeof record.skill_version==='number'?{...skill,version:record.skill_version}:skill),frozen);
 fields.skills=rootSkills.length?JSON.stringify(rootSkills.map(skill=>skill.name)):null;
 fields.invokedSkills=rootSkills.length?JSON.stringify(rootSkills):null;
 if(Array.isArray(state.mergedInteractionsForSession))fields.callStats=JSON.stringify(computeCallStats(state.mergedInteractionsForSession,{fallbackModel:record.model??null,failures:record.failures?JSON.stringify(record.failures):null}));
 const session=prepareExecutionSession({record,interactions:state.mergedInteractionsForSession,existingSession:canonicalSession,defaultTimestamp:timestamp});
 if(session.session&&reservation.completed_at_ms!=null)session.session.endTime=new Date(reservation.completed_at_ms).toISOString();
 const childPlan=supportsSubagentExecutionDerivation(record.framework)?prepareSubagentExecutions({parentExecutionId:reservation.execution_id,parentTaskId:reservation.task_id,parentFramework:record.framework,parentUser:frozen.actor.username,clientId:fields.clientId,hostIp:fields.hostIp,hostName:fields.hostName,observedIp:fields.observedIp,interactions:state.mergedInteractionsForSession??[],lastIngestedAt:fields.lastIngestedAt},timestamp):{children:[],sweep:false};
 const children=childPlan.children.map(child=>{
  const skills=pinnedSkills(child.skills,frozen);
  const prior=frozen.graph_context?.children?.find((member:Row)=>member.execution_id===child.execution.id);
  const priorSession=prior?.session_json?JSON.parse(prior.session_json):prior?.snapshot?.session;
  const session=portableSession({...priorSession,...child.session,startTime:child.sessionHasStart?child.session.startTime:priorSession?.startTime??child.session.startTime,endTime:prior?.completion_at_ms!=null?new Date(prior.completion_at_ms).toISOString():child.session.endTime||priorSession?.endTime||null});
  return {snapshot:{execution:portableExecution({...child.execution,invokedSkills:skills,skills:skills.map(skill=>skill.name)},prior?.snapshot?.execution),session},skills,serialized_session_json:JSON.stringify(session),execution_skills:prepareExecutionSkills(skills,{user:frozen.actor.username},prior?.execution_skills??[])};
 });
 const postHooks:Row[]=[];
 if(record.framework){
  postHooks.push({kind:'register_agents',platform:record.framework,user:frozen.actor.username,agents:extractObservedAgentRegistrations(state.mergedInteractionsForSession,agentName).map(agent=>({...agent,agentOwnership:isInternalSystemAgentTrace(agent.name)?'system':'user'}))});
  if(frameworkAgent&&!['pi-agent','codex'].includes(record.framework))postHooks.push({kind:'normalize_framework_identity_history',framework:record.framework,user:frozen.actor.username,primaryAgentName:frameworkAgent});
  if(record.framework==='codex')postHooks.push({kind:'normalize_legacy_codex_history',user:frozen.actor.username});
 }
 if(record.traceThreadId)postHooks.push({kind:'reconcile_trace_thread',threadId:record.traceThreadId});
 postHooks.push({kind:'goal_plus_relink',user:frozen.actor.username},{kind:'collaboration_resolve',user:frozen.actor.username,references:[record.task_id||'',record.agent_session_id||'']});
 for(const update of configUpdates)postHooks.push({kind:'config_key_actions',...update});
 const background=!isInProgressOpencodeSnapshot(data)&&frozen.settings.autoEvaluationEnabled;
 return jsonClone({binding:binding(reservation),skipped:false,snapshot:{execution:portableExecution(fields,reservation.snapshot?.execution),session:portableSession(session.session)},record:session.record,normalized,
  root_skills:rootSkills,skill_origins:record.skill_origins??[],execution_skills:prepareExecutionSkills(rootSkills,{user:frozen.actor.username,primaryName:record.skill,origins:record.skill_origins},frozen.graph_context?.root_execution_skills??[]),children,retire_missing_children:childPlan.sweep,thread,post_hooks:postHooks,background_analysis:background,
  analysis:{kind:'upload_analysis',enabled:background,model_selection:frozen.model_selection??null,expected_base_revision:reservation.base_revision,query:record.query??null,skill:record.skill??null,configs,execution_match:frozen.execution_match}});
}

export function prepareCoreCollectorCompletion(reservation:CollectorReservation,frozen:FrozenCollectorPreparation){
 if(reservation.operation!=='complete')throw failure(400,'Collector completion reservation required');
 check(reservation,frozen,'complete');
 if(!Number.isSafeInteger(reservation.completed_at_ms)||reservation.completed_at_ms!<0)throw failure(400,'Invalid collector completion time');
 const endTime=new Date(reservation.completed_at_ms!).toISOString();
 const previous=reservation.snapshot?.session??frozen.previous_session;
 const session=previous?{...jsonClone(previous),endTime}:{taskId:reservation.task_id,user:frozen.actor.username,label:'opencode',query:null,model:null,startTime:new Date(reservation.received_at_ms).toISOString(),endTime,interactions:[]};
 return {binding:binding(reservation),disposition:'completion',session,snapshot:reservation.snapshot?{execution:jsonClone(reservation.snapshot.execution),session}:null,response:{success:true,task_id:reservation.task_id,endTime}};
}

export function prepareCoreCollectorThread(reservation:CollectorReservation,frozen:FrozenCollectorPreparation){
 if(reservation.operation!=='thread_only')throw failure(400,'Collector Thread-only reservation required');
 check(reservation,frozen,'thread_only');
 const raw=reservation.operation_request.data??reservation.operation_request;
 if(!raw.threadOnly)throw failure(400,'Collector Thread-only input required');
 const thread=prepareTraceThread({data:{...structuredClone(raw),user:frozen.actor.username},threadId:frozen.thread_id??undefined});
 return {binding:binding(reservation),disposition:'thread_only',snapshot:null,session:null,children:[],thread,post_hooks:[],background_analysis:false};
}
