import {recordUsageEvent} from '@/lib/usage-analytics/collector';
import {db,prismaRaw} from '@/lib/storage/prisma';
import {readConfig,findBestMatchConfig,findBestOutcomeConfig,findBestRoutingConfig,extractInvokedSkillsFromSessionInteractions,fillConfigKeyActionsFromParsedFlows,getEvaluationContextLabel,buildRecordEvaluationSnapshots,resolveImmutableSkillVersion} from '@/lib/storage/data-service';
import {judgeAnswer,analyzeFailures,normalizeInteractions,type InvokedSkill,type JudgeCriteria} from '@/lib/engine/evaluation/judge';
import {isEvaluatorTraceRecord} from '@/lib/evaluator-agent';
import {requireCoreExperimentContext,withCoreExperiments,lookupCoreExperimentOperation,coreExperimentFailure,type CoreExperimentContext} from './experiments';
import {activateExperimentWork,type FrozenExperimentWork} from './experiment-worker';
import {withCoreFlowModelDelivery} from './flow-model-delivery';
import {readTraceEvidence,readTraceOutcomeEvidence} from './evidence';
import {getActiveConfig} from '@/lib/storage/server-config';
import {freezeModelSelection} from './frozen-model';
import {requestCore} from './server';
import type {CoreFlowLookup} from './flow-analysis';
import type {ExecutionRecord} from '@/lib/storage/data-service';
import {overlayCoreOutcome,type CoreOutcomeValue,type CoreOutcomeLookup,type CoreOutcomeRecordProjection,type CoreQueryProjection} from './trace-outcome-projection';
export {overlayCoreOutcome,type CoreOutcomeValue,type CoreOutcomeLookup,type CoreOutcomeRecordProjection,type CoreQueryProjection} from './trace-outcome-projection';

type Row=Record<string,unknown>;
export const CORE_OUTCOME_SCOPE='trace-outcome';
export const CORE_OUTCOME_SLOT='__trace_outcome__';
interface OutcomeManifest {
 version:1;mode:'rejudge'|'edited-final-result';trace_id:string;trace_snapshot_hash:string;
 criteria:JudgeCriteria|null;query:string;skill_name:string;skill_definition:string|null;invoked_skills:InvokedSkill[];skill_version:number|null;
 model_selection:Row|null;execution_steps:Array<{name:string;description:string;type:string}>|null;
 flow_source:{experiment_id:string;machine_result_id:string;content_hash:string;run_id:string}|null;
 record_projection?:CoreOutcomeRecordProjection;
 previous_outcome_selection?:string;
 previous_outcome?:{selection_hash:string;failures:unknown[];skill_issues:unknown[]|null};
}
interface OutcomeBegin {experiment_id:string;run_id:string;result_id:string;trace_id:string;execution_id:string;task_id:string}
function unavailable(message:string,status=503):never{throw Object.assign(new Error(message),{status});}
function optionalArray(value:unknown):unknown[]|undefined{if(Array.isArray(value))return value;if(typeof value==='string'&&value){try{const parsed=JSON.parse(value);if(Array.isArray(parsed))return parsed;}catch{}}return undefined;}
function array(value:unknown):unknown[]{return optionalArray(value)??[];}
function routingScalars(record:ExecutionRecord,evaluated:ExecutionRecord){
 const hasSkills=Array.isArray(record.invokedSkills)&&record.invokedSkills.length>0||Array.isArray(record.skills)&&record.skills.length>0;
 return {is_skill_correct:evaluated.routing_evaluation?.is_correct??false,skill_trigger_rate:hasSkills?evaluated.routing_evaluation?.trigger_rate??null:null};
}
async function assertFlow(context:CoreExperimentContext,manifest:OutcomeManifest){
 if(!manifest.flow_source)return;
 const selected=await context.rpc('flow_lookup',{trace_ref:manifest.trace_id,experiment_id:manifest.flow_source.experiment_id}) as CoreFlowLookup;
 if(!selected.match||['machine_result_id','content_hash','run_id'].some(key=>selected.match![key as keyof NonNullable<CoreFlowLookup['match']>]!==manifest.flow_source![key as keyof NonNullable<OutcomeManifest['flow_source']>]))unavailable('Frozen Outcome Flow selection changed',409);
}
async function assertSkill(context:CoreExperimentContext,manifest:OutcomeManifest){
 const identity=(manifest as OutcomeManifest&{skill_identity?:{id:string;record_name:string}}).skill_identity;
 if(!identity)return;
 const row=await prismaRaw.skill.findFirst({where:{id:identity.id,name:identity.record_name,OR:[{user:context.actor.username},{user:null}]},select:{id:true}});
 if(!row)unavailable('Frozen Outcome Skill is no longer accessible',403);
}
export async function computeFrozenCoreOutcomeWork(work:FrozenExperimentWork,options:{user:string;signal:AbortSignal}){
 const context=requireCoreExperimentContext();if(context.actor.username!==options.user)unavailable('Outcome actor differs',403);
 const manifest=(work.runplan.config as Row|undefined)?.core_outcome as OutcomeManifest|undefined;
 const source=work.frozen_trace_evidence;
 if(work.handle.evaluator_id!==CORE_OUTCOME_SLOT||work.experiment_config.scope!==CORE_OUTCOME_SCOPE||!manifest||manifest.version!==1||!['rejudge','edited-final-result'].includes(manifest.mode)||!source?.execution||manifest.mode==='rejudge'&&!Array.isArray(source.session?.interactions)||source.session!=null&&!Array.isArray(source.session.interactions))unavailable('Frozen Outcome inputs are unavailable');
 if(source.snapshot_hash!==manifest.trace_snapshot_hash||(source.manifest as Row)?.trace_id!==manifest.trace_id)unavailable('Frozen Outcome Trace differs',409);
 await assertSkill(context,manifest);await assertFlow(context,manifest);options.signal.throwIfAborted();await context.rpc('check_work',work.handle);
 const execution=source.execution;
 const result=await withCoreFlowModelDelivery(context,work,async()=>{
  let score:number|null=null,isCorrect=false,reason='未找到匹配的效果评测配置';
  let failures:unknown[]=manifest.previous_outcome?.failures??array(execution.failures),skillIssues:unknown[]|null=manifest.previous_outcome?manifest.previous_outcome.skill_issues:execution.skillIssues==null?null:array(execution.skillIssues);
  if(manifest.criteria){
   const judgment=await judgeAnswer(manifest.query,{...manifest.criteria,skill_definition:manifest.skill_definition||undefined},String(execution.finalResult||''),options.user,manifest.execution_steps);
   options.signal.throwIfAborted();score=typeof judgment?.score==='number'?judgment.score:0;isCorrect=judgment.is_correct;reason=judgment.reason||(manifest.mode==='rejudge'?'Rejudged':'Judged by Evaluation Model');
   if(manifest.mode==='rejudge'&&score===0&&(reason.includes('failed')||reason.includes('disabled')||reason.includes('禁用')))throw Object.assign(new Error('Judgment failed: '+reason),{coreOutcomeBusinessError:true});
   if(manifest.mode==='rejudge'){
    const evaluator=isEvaluatorTraceRecord({agent:typeof execution.agentName==='string'?execution.agentName:undefined,agentName:typeof execution.agentName==='string'?execution.agentName:undefined,query:manifest.query,final_result:String(execution.finalResult||''),label:typeof execution.label==='string'?execution.label:undefined});
    const analysis=evaluator?{failures:[],skill_issues:[]}:await analyzeFailures(normalizeInteractions(source.session!.interactions as unknown[]),manifest.skill_name,manifest.skill_definition||undefined,score,reason,manifest.query,String(execution.finalResult||''),options.user);
    failures=analysis.failures;skillIssues=analysis.skill_issues??null;
   }
  }else if(manifest.mode==='rejudge')unavailable('No matching evaluation configuration found for this query. Please ensure a valid configuration exists before re-judging.',400);
  const template=manifest.record_projection;
  const outcomeTemplate=template?.outcome_evaluation;
  const recordProjection=template&&outcomeTemplate?{...template,outcome_evaluation:{...outcomeTemplate,reason,
   ...(outcomeTemplate.status==='available'?{score,is_correct:isCorrect}:{}),
   skill_breakdown:outcomeTemplate.skill_breakdown.map(item=>({...item,score:outcomeTemplate.status==='available'?score:null,is_correct:outcomeTemplate.status==='available'?isCorrect:null}))}}:undefined;
  const value:CoreOutcomeValue={version:1,source_snapshot_hash:String(source.snapshot_hash),answer_score:score,is_answer_correct:isCorrect,judgment_reason:reason,failures,skill_issues:skillIssues,...(recordProjection?{record_projection:recordProjection}:{})};
  return {score:score===null?null:score*100,points:[],evidence:{json:{coreOutcome:value}}};
 });
 options.signal.throwIfAborted();await assertSkill(context,manifest);await assertFlow(context,manifest);await context.rpc('check_work',work.handle);return result;
}

async function freeze(context:CoreExperimentContext,reference:string,mode:OutcomeManifest['mode']):Promise<OutcomeManifest>{
 const previous=await context.rpc('outcome_lookup',{trace_ref:reference,require_write:true}) as CoreOutcomeLookup;
 const captured=await (mode==='edited-final-result'?readTraceOutcomeEvidence:readTraceEvidence)(context.request,{traceRef:reference},context.options);if(captured.username!==context.actor.username)unavailable('Outcome source actor differs',403);
 const evidence=captured.evidence,execution=evidence.execution,normalized=normalizeInteractions(evidence.session?.interactions||[]);
 const effective=previous.outcome?.value.record_projection?{...execution,...previous.outcome.value.record_projection,skillVersion:previous.outcome.value.record_projection.skill_version}:execution;
 let invoked=optionalArray(effective.invokedSkills) as InvokedSkill[]|undefined;
 if(mode==='rejudge'&&!invoked?.length)invoked=extractInvokedSkillsFromSessionInteractions(String(execution.framework||''),normalized)??[];
 const existingVersion=typeof effective.skillVersion==='number'?effective.skillVersion:null;
 const requestedVersion=mode==='rejudge'?invoked?.[0]?.version??existingVersion:existingVersion;
 const skillVersion=resolveImmutableSkillVersion({isUpdate:true,existingSkillVersion:existingVersion,incomingSkillVersion:requestedVersion,explicitRewrite:false}).resolved;
 const skillName=mode==='rejudge'?invoked?.[0]?.name||String(effective.skill||'').trim():typeof effective.skill==='string'?effective.skill||undefined:undefined;
 const skills=mode==='rejudge'?(invoked??[]).map(item=>item.name):optionalArray(effective.skills) as string[]|undefined;
 const configs=await readConfig(context.actor.username);
 const record:ExecutionRecord={query:String(execution.query||''),skill:skillName,skill_version:skillVersion,invokedSkills:invoked,skills};
 const cfg=mode==='rejudge'?findBestMatchConfig(configs,record.query,'outcome'):findBestOutcomeConfig(configs,record);
 if(!cfg&&mode==='rejudge')unavailable('No matching evaluation configuration found for this query. Please ensure a valid configuration exists before re-judging.',400);
 if(cfg&&mode==='edited-final-result')await fillConfigKeyActionsFromParsedFlows(cfg,context.actor.username);
 let definition:string|null=null;let skillIdentity:{id:string;record_name:string}|undefined;
 const target=mode==='rejudge'?skillName||'':skillName||cfg?.skill||(await findBestRoutingConfig(configs,record.query,context.actor.username))?.skill||'';
 if(target){
  const found=await db.findSkill(target,context.actor.username);
  if(found?.versions?.length){
   const desired=cfg?.skillVersion??skillVersion??found.activeVersion??0;
   const version=mode==='rejudge'?found.versions[0]:found.versions.find((item:{version:number;content:string})=>item.version===desired)||found.versions[0];
   definition=version.content;skillIdentity={id:found.id,record_name:found.name};
  }
 }
 const previousOutcome=previous?.outcome?{selection_hash:previous.selection_hash,failures:previous.outcome.value.failures,skill_issues:previous.outcome.value.skill_issues}:undefined;
 const flow=await context.rpc('flow_lookup',{trace_ref:evidence.manifest.trace_id}) as CoreFlowLookup;
 let executionSteps:OutcomeManifest['execution_steps']=null,flowSource:OutcomeManifest['flow_source']=null;
 if(flow.match){
  const raw=flow.match.value.extractedSteps;const steps=typeof raw==='string'&&raw?JSON.parse(raw):raw;
  executionSteps=Array.isArray(steps)?steps:null;
  flowSource={experiment_id:flow.match.experiment_id,machine_result_id:flow.match.machine_result_id,content_hash:flow.match.content_hash,run_id:flow.match.run_id};
 }
 const evaluated=await buildRecordEvaluationSnapshots({...record,answer_score:null,is_answer_correct:false,judgment_reason:'Rejudged',user:context.actor.username},configs,context.actor.username);
 const recordProjection:CoreOutcomeRecordProjection={...(skills!==undefined?{skills}:{}),...(invoked!==undefined?{invokedSkills:invoked}:{}),...(skillName!==undefined?{skill:skillName}:{}),skill_version:skillVersion,...routingScalars(record,evaluated),routing_evaluation:evaluated.routing_evaluation!,outcome_evaluation:evaluated.outcome_evaluation!};
 return {version:1,mode,trace_id:evidence.manifest.trace_id,trace_snapshot_hash:evidence.snapshot_hash,criteria:cfg?{root_causes:cfg.root_causes,key_actions:cfg.key_actions,standard_answer_example:cfg.standard_answer}:null,query:mode==='rejudge'?record.query||'':getEvaluationContextLabel(record,cfg),skill_name:target,skill_definition:definition,skill_version:skillVersion,invoked_skills:invoked??[],record_projection:recordProjection,model_selection:freezeModelSelection(await getActiveConfig(context.actor.username)),execution_steps:executionSteps,flow_source:flowSource,...(skillIdentity?{skill_identity:skillIdentity}:{}),...(previous?{previous_outcome_selection:previous.selection_hash}:{}),...(previousOutcome?{previous_outcome:previousOutcome}:{})};
}
async function begin(context:CoreExperimentContext,reference:string,mode:OutcomeManifest['mode'],finalResult?:string):Promise<OutcomeBegin>{
 const replay=await lookupCoreExperimentOperation(context,'outcome_begin');if(replay)return replay as unknown as OutcomeBegin;
 const manifest=await freeze(context,reference,mode);
 const result=await context.rpc('outcome_begin',{trace_ref:reference,config:{core_outcome:manifest},...(finalResult!==undefined?{final_result:finalResult}:{})}) as OutcomeBegin;
 if(!result||![result.experiment_id,result.run_id,result.result_id,result.trace_id,result.execution_id,result.task_id].every(value=>typeof value==='string'&&value))unavailable('Outcome scheduling receipt unavailable');
 return result;
}
export async function readCoreOutcome(reference:string,options:{requireWrite?:boolean}={}):Promise<CoreOutcomeLookup>{return requireCoreExperimentContext().rpc('outcome_lookup',{trace_ref:reference,...(options.requireWrite?{require_write:true}:{})}) as Promise<CoreOutcomeLookup>;}

async function publicRecord(context:CoreExperimentContext,started:Pick<OutcomeBegin,'execution_id'|'task_id'>,selected:CoreOutcomeLookup){
 const {data}=await requestCore('/v1/compat/observe/data?'+new URLSearchParams({workspace_id:context.actor.workspace,executionId:started.execution_id}),{token:context.actor.token,responseLimit:16*1024*1024},context.options.fetcher||fetch);
 if(!Array.isArray(data.value)||data.value.length!==1)unavailable('Rejudged Trace record unavailable');
 const current=await readCoreOutcome(started.task_id);
 if(current.selection_hash!==selected.selection_hash)unavailable('Outcome selection changed during record read',409);
 return overlayCoreOutcome(data.value[0] as ExecutionRecord,selected);
}
function reference(body:Row,preferExecution=false){const value=preferExecution?body.upload_id||body.task_id:body.task_id||body.upload_id;if(typeof value!=='string'||!value)return null;return value;}
export async function handleCoreOutcomeRejudge(request:Request):Promise<Response>{
 try{return await withCoreExperiments(request,async()=>{
  const context=requireCoreExperimentContext(),task=reference(context.body);
  if(!task)return Response.json({error:'taskId required'},{status:400});
  if(!context.body.currentUser)return Response.json({error:'currentUser is required'},{status:400});
  const started=await begin(context,task,'rejudge');
  try{await activateExperimentWork(context,started.experiment_id,{concurrency:1});}
  catch(cause){
   const failure=cause as {status?:number;coreDeliveryUncertain?:boolean;coreTraceRecordingStatus?:number};
   const recordingRejected=[409,410].includes(failure?.coreTraceRecordingStatus??0);
   const attemptRejected=!failure?.coreDeliveryUncertain&&[409,410].includes(failure?.status??0);
   if(!recordingRejected&&!attemptRejected)throw cause;
   const current=await readCoreOutcome(task);
   const slot=await context.rpc('result_lookup',{result_id:started.result_id}) as {experiment_id:string;result_id:string;evaluator_id:string;status:string};
   if(current.experiment_id!==started.experiment_id||slot.experiment_id!==started.experiment_id||slot.result_id!==started.result_id||slot.evaluator_id!==CORE_OUTCOME_SLOT||!['pending','running','done','failed','cancelled','skipped'].includes(slot.status))throw cause;
   const confirmed=await readCoreOutcome(task);
   if(confirmed.experiment_id!==started.experiment_id||confirmed.run_id!==current.run_id)throw cause;
   const cancelled=current.run_id===started.run_id&&!current.is_evaluating&&!confirmed.is_evaluating&&slot.status==='cancelled';
   const superseded=typeof current.run_id==='string'&&current.run_id!==started.run_id;
   if(cancelled||superseded)return Response.json({success:false,cancelled:true,message:'Evaluation cancelled'});
   throw cause;
  }
  const selected=await readCoreOutcome(task);
  if(selected.run_id!==started.run_id)return Response.json({success:false,cancelled:true,message:'Evaluation cancelled'});
  if(selected.is_evaluating)unavailable('Outcome is still evaluating',503);
  const status=await context.rpc('result_lookup',{result_id:started.result_id}) as {status:string};
  if(status.status==='cancelled')return Response.json({success:false,cancelled:true,message:'Evaluation cancelled'});
  if(status.status==='failed'){
   const failed=await context.rpc('read',{experiment_id:started.experiment_id}) as {experiment:{cases:Array<{results:Array<{id:string;errorMessage?:string|null}>}>}};
   const error=failed.experiment.cases.flatMap(item=>item.results).find(item=>item.id===started.result_id)?.errorMessage;
   return Response.json({error:error?.startsWith('Judgment failed:')?error:'Failed to rejudge'},{status:500});
  }
  if(status.status!=='done'||selected.outcome?.run_id!==started.run_id)unavailable('Failed to rejudge',503);
  return Response.json({success:true,message:'Rejudged and re-analyzed successfully',record:await publicRecord(context,started,selected)});
 });}catch(cause){
  const error=cause as {status?:number;message?:string};
  if(error.status===400&&error.message?.startsWith('No matching evaluation configuration'))return Response.json({error:error.message},{status:400});
  return coreExperimentFailure(cause);
 }
}
export async function handleCoreOutcomeCancel(request:Request):Promise<Response>{
 try{return await withCoreExperiments(request,async()=>{
  const context=requireCoreExperimentContext(),task=reference(context.body);
  if(!task)return Response.json({error:'task_id or upload_id is required'},{status:400});
  if(!context.body.currentUser)return Response.json({error:'currentUser is required'},{status:400});
  return Response.json(await context.rpc('outcome_cancel',{trace_ref:task}));
 });}catch(cause){return coreExperimentFailure(cause);}
}
export async function handleCoreFinalResultEdit(request:Request,options:import('./compat').CompatibilityOptions={}):Promise<Response>{
 try{return await withCoreExperiments(request,async()=>{
  const context=requireCoreExperimentContext(),task=reference(context.body,true);
  if(!task)return Response.json({error:'upload_id or task_id is required'},{status:400});
  if(typeof context.body.final_result!=='string')return Response.json({error:'final_result must be a string'},{status:400});
  const started=await begin(context,task,'edited-final-result',context.body.final_result.trim());
  void activateExperimentWork(context,started.experiment_id,{concurrency:1}).catch(error=>console.error('[Core Outcome] Background evaluation pending',{status:(error as {status?:number})?.status||503}));
  recordUsageEvent({user:context.actor.username,featureKey:'trace',eventKey:'trace.update'});
  return Response.json({success:true,message:'Final Result 已保存，正在后台重新评估'});
 },options);}catch(cause){return coreExperimentFailure(cause);}
}


export async function handleCoreQueryEdit(request:Request,options:import('./compat').CompatibilityOptions={}):Promise<Response>{
 try{return await withCoreExperiments(request,async()=>{
  const context=requireCoreExperimentContext(),task=reference(context.body,true);
  if(!task)return Response.json({error:'task_id or upload_id is required'},{status:400});
  if(typeof context.body.query!=='string'||!context.body.query.trim())return Response.json({error:'query must be a non-empty string'},{status:400});
  let saved=await lookupCoreExperimentOperation(context,'outcome_query') as Pick<OutcomeBegin,'execution_id'|'task_id'>|null;
  if(!saved){
   const previous=await readCoreOutcome(task,{requireWrite:true});
   const captured=await readTraceOutcomeEvidence(context.request,{traceRef:task},context.options);if(captured.username!==context.actor.username)unavailable('Query source actor differs',403);
   const evidence=captured.evidence;
   const effective=previous.outcome?.value.record_projection?{...evidence.execution,...previous.outcome.value.record_projection,skillVersion:previous.outcome.value.record_projection.skill_version}:evidence.execution;
   const record:ExecutionRecord={query:context.body.query.trim(),skill:typeof effective.skill==='string'?effective.skill||undefined:undefined,skill_version:typeof effective.skillVersion==='number'?effective.skillVersion:null,skills:optionalArray(effective.skills) as string[]|undefined,invokedSkills:optionalArray(effective.invokedSkills) as InvokedSkill[]|undefined,answer_score:null,is_answer_correct:false,judgment_reason:'结果评估中...',user:context.actor.username};
   const evaluated=await buildRecordEvaluationSnapshots(record,await readConfig(context.actor.username),context.actor.username);
   const projection:CoreQueryProjection={...routingScalars(record,evaluated),routing_evaluation:evaluated.routing_evaluation!,outcome_evaluation:evaluated.outcome_evaluation!};
   saved=await context.rpc('outcome_query',{trace_ref:task,query:record.query,source_snapshot_hash:evidence.snapshot_hash,previous_outcome_selection:previous.selection_hash,query_projection:projection}) as Pick<OutcomeBegin,'execution_id'|'task_id'>;
   if(!saved||typeof saved.execution_id!=='string'||typeof saved.task_id!=='string')unavailable('Query scheduling receipt unavailable');
  }
  const selected=await readCoreOutcome(saved.task_id);
  const record=await publicRecord(context,saved,selected);
  recordUsageEvent({user:context.actor.username,featureKey:'trace',eventKey:'trace.update'});
  return Response.json({success:true,message:'Query 已更新',record});
 },options);}catch(cause){return coreExperimentFailure(cause);}
}
