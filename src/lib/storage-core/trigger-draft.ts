import {createHash} from 'node:crypto';
import matter from 'gray-matter';
import {draftTriggerEvalSet,resolveDraftModelConfig} from '@/lib/engine/skill-generation/evaluator/runners/draftTriggerEvalSet';
import {freezeModelSelection,matchesFrozenModelSelection} from './frozen-model';
import {prepareCoreExperimentRuntime,requireCoreExperimentContext,lookupCoreExperimentOperation,type CoreExperimentContext} from './experiments';
import {withCoreFlowModelDelivery,executeCoreFlowModelCall} from './flow-model-delivery';
import type {FrozenExperimentWork} from './experiment-worker';
import type {FrozenTriggerManifest} from './trigger';
import type {SkillTriggerEvalSetRecord,TriggerItem} from '@/server/skill_trigger_eval_storage';

type Row=Record<string,unknown>;
interface DraftManifest extends FrozenTriggerManifest {draft_preparation_error?:string;kind:'draft';placeholder:SkillTriggerEvalSetRecord;draft_skill:{description:string;body:string;contentHash:string}}
interface DraftValue {experiment_id:string;set:SkillTriggerEvalSetRecord;status:string;result?:{version:1;set_id:string;items:TriggerItem[];draftedFromSkillHash:string;skillDescription:string}|null;error?:string|null}
const fail=(message:string,status:number)=>Object.assign(new Error(message),{status});
const asModel=(value:Awaited<ReturnType<typeof resolveDraftModelConfig>>)=>({id:'trigger-draft-'+value.source,name:'Trigger draft frozen model',model:value.modelId,apiKey:value.apiKey||'',provider:value.provider,baseUrl:value.baseUrl,headers:value.headers});
function itemId(experiment:string,index:number){const hash=createHash('sha1').update('trigger-draft-item/v1:'+experiment+':'+index).digest('hex').slice(0,32).split('');hash[12]='5';hash[16]=((parseInt(hash[16],16)&3)|8).toString(16);const raw=hash.join('');return `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;}
export async function finalizeCoreTriggerDraft(context:CoreExperimentContext,id:string):Promise<SkillTriggerEvalSetRecord|null>{
 const value=await context.rpc('trigger_draft_read',{experiment_id:id}) as DraftValue;
 if(value?.experiment_id!==id||!value.set?.id)throw fail('Draft binding unavailable',503);
 if(!['done','failed'].includes(value.status))return null;
 const {compareAndSetCoreTriggerDraft}=await import('@/server/skill_trigger_eval_storage');
 if(value.status==='failed')return compareAndSetCoreTriggerDraft(value.set,{status:'failed',versionNote:(value.error||'Draft failed').slice(0,500)});
 const result=value.result;if(!result||result.set_id!==value.set.id||!Array.isArray(result.items)||!result.items.length)throw fail('Draft result unavailable',503);
 return compareAndSetCoreTriggerDraft(value.set,{status:'ready',items:result.items,draftedFromSkillHash:result.draftedFromSkillHash,versionNote:value.set.versionNote});
}
export async function evaluateCoreTriggerDraftWork(work:FrozenExperimentWork,context:CoreExperimentContext,signal?:AbortSignal):Promise<Row>{
 const manifest=(work.runplan.config as Row)?.core_trigger as DraftManifest;
 if(manifest?.kind!=='draft'||work.experiment_config.scope!=='skill-trigger-analysis'||work.handle.evaluator_id!=='__skill_trigger_draft__')throw fail('Frozen draft work required',503);
 if(manifest.draft_preparation_error)throw Error(manifest.draft_preparation_error);
 const checkpoint=(work as FrozenExperimentWork&{checkpoint?:Row}).checkpoint||{};const calls=checkpoint._flow_model_calls as Record<string,Row>|undefined;
 if(calls&&Object.values(calls).some(call=>call.state!=='observed'||!call.response))throw Object.assign(fail('Draft model delivery is not confirmed',503),{coreDeliveryUncertain:true});
 const replay=!!calls?.['0'];const resolved=replay?{modelId:String(manifest.model_selection?.model||''),provider:manifest.model_selection?.provider as string|undefined,source:'env' as const}:await resolveDraftModelConfig(context.actor.username,manifest.modelConfigId);
 const model=asModel(resolved);
 if(!replay&&(!manifest.model_selection||!matchesFrozenModelSelection(model,manifest.model_selection)))throw fail('Frozen draft model connection changed',503);
 const deliveryContext={...context,rpc:(action:string,payload:Row={})=>context.rpc(action,action==='checkpoint'?{...payload,trigger_draft:true}:payload)};
 const execute=()=>withCoreFlowModelDelivery(deliveryContext,work,()=>draftTriggerEvalSet({user:manifest.legacy_owner,skillName:manifest.skill.name,replaceUserEdited:true,coreRuntime:{skillContent:manifest.draft_skill,model:resolved,signal,itemId:index=>itemId(work.handle.experiment_id,index),invoke:async(request,perform)=>{
  const response=await executeCoreFlowModelCall({...request,model_selection:manifest.model_selection},async()=>{
   const startedAt=new Date().toISOString();let value:{content:unknown;usage_metadata?:unknown}|undefined;let error:unknown;
   try{signal?.throwIfAborted();value=await perform();}catch(cause){error=cause;}
   const {sanitizeAgentDiagnostic}=await import('../../../scripts/agent-run-diagnostics.cjs');
   const failure=error?sanitizeAgentDiagnostic(error instanceof Error?error.message:String(error)):null;
   const content=value?typeof value.content==='string'?value.content:JSON.stringify(value.content):'';const task_id='trigger-draft-'+work.handle.experiment_id;
   const {recordDirectEvaluatorExecution}=await import('@/lib/engine/evaluation/evaluator-execution-recorder');
   const usage=value?.usage_metadata as {input_tokens?:number;output_tokens?:number;total_tokens?:number}|undefined;
   const recorded=await recordDirectEvaluatorExecution({taskId:task_id,agentName:'skill-trigger-drafter',user:manifest.legacy_owner,query:'起草触发评价集 '+manifest.skill.name,skill:manifest.skill.name,skillVersion:manifest.skill.version,systemPrompt:request.systemPrompt,userMessage:request.userPrompt,assistantOutput:content,modelID:resolved.modelId,usage:usage?{input:usage.input_tokens,output:usage.output_tokens,total:usage.total_tokens}:undefined,startedAtISO:startedAt,completedAtISO:new Date().toISOString(),...(failure?{failure:{code:'TRIGGER_DRAFT_MODEL_FAILED',message:failure}}:{})});
   if(recorded<2)throw Object.assign(new Error('Draft Judge Trace was not recorded'),{code:'CORE_TRACE_RECORDING_FAILED'});
   return {task_id,content,failure};
  });
  if(response.failure)throw Error(response.failure);signal?.throwIfAborted();return response;
 }}}));
 const result=await (replay?execute():prepareCoreExperimentRuntime(context,work,execute,{signal,modelConfiguration:model}));
 return {score:null,points:[],summary:'触发评价集起草完成',evidence:{json:{coreTriggerDraft:{version:1,set_id:manifest.placeholder.id,...result}}}};
}
export async function startDraft(skillName:string,body:Row):Promise<Response>{
 const context=requireCoreExperimentContext();const storage=await import('@/server/skill_trigger_eval_storage');
 let receipt=await lookupCoreExperimentOperation(context,'trigger_begin') as {experiment_id:string;set:SkillTriggerEvalSetRecord}|null;
 if(!receipt){
  const refs=await context.rpc('trigger_draft_refs',{skill_name:skillName}) as {drafts:Array<{experiment_id:string;set_id:string;status:string}>};
  if(!Array.isArray(refs?.drafts))throw fail('Draft reference coverage unavailable',503);
  for(const ref of refs.drafts){
   const set=await storage.findTriggerEvalSetById(ref.set_id);
   if(set?.status==='drafting'&&['done','failed'].includes(ref.status))await finalizeCoreTriggerDraft(context,ref.experiment_id);
   if(ref.status==='running'){if(!set)throw fail('Previous draft delivery is not confirmed',503);throw Object.assign(fail('该 Skill 已有一次 AI 起草正在进行，等它结束再发起',409),{set});}
  }
  const id='trigger-draft-'+createHash('sha256').update(JSON.stringify([context.actor.workspace,context.actor.principal,context.operationKey])).digest('hex').slice(0,40);
  let placeholder=await storage.findTriggerEvalSetById(id);
  const fresh=await storage.findFreshDraftingSet(context.actor.username,skillName);
  if(fresh&&fresh.id!==id)throw Object.assign(fail('该 Skill 已有一次 AI 起草正在进行，等它结束再发起',409),{set:fresh});
  const {prismaRaw}=await import('@/lib/storage/prisma');const skill=await prismaRaw.skill.findFirst({where:{user:context.actor.username,name:skillName},include:{versions:{orderBy:{version:'desc'},take:1}}});
  if(!skill?.versions[0])throw fail('skill not found or no version',404);
  const selected=skill.versions[0],content=selected.content||'';let description=skill.description||'',text=content;try{const parsed=matter(content);if(typeof parsed.data?.description==='string'&&parsed.data.description.trim())description=parsed.data.description.trim();text=parsed.content||content;}catch{}
  let resolved:Awaited<ReturnType<typeof resolveDraftModelConfig>>|undefined;let preparationError:string|undefined;
  try{resolved=await resolveDraftModelConfig(context.actor.username,body.modelConfigId?String(body.modelConfigId).trim():undefined);}catch(error){const {sanitizeAgentDiagnostic}=await import('../../../scripts/agent-run-diagnostics.cjs');preparationError=sanitizeAgentDiagnostic(error instanceof Error?error.message:String(error));}
  if(!placeholder){await storage.deletePlaceholderDraftingSets(context.actor.username,skillName);try{placeholder=await storage.createTriggerEvalSetVersion({id,user:context.actor.username,skillName,items:[],versionSource:'llm-draft',versionNote:body.modelConfigId?'model='+String(body.modelConfigId).trim():null,status:'drafting'});}catch(error){placeholder=await storage.findTriggerEvalSetById(id);if(!placeholder)throw error;}}
  if(placeholder.user!==context.actor.username||placeholder.skillName!==skillName||placeholder.status!=='drafting'||placeholder.items.length)throw fail('Draft placeholder differs from its operation',409);
  const manifest:DraftManifest={version:1,kind:'draft',legacy_owner:context.actor.username,skill:{id:skill.id,name:skill.name,version:selected.version,content},siblings:[],history:[],params:{runsPerQuery:1,triggerThreshold:.5,timeoutMs:60000,concurrency:1,maxTimeoutRetries:0},trigger_set:{id:placeholder.id,version:placeholder.version,items:[]},placeholder,draft_skill:{description,body:text,contentHash:createHash('sha256').update(content).digest('hex').slice(0,16)},...(preparationError?{draft_preparation_error:preparationError}:{}),model_selection:resolved?freezeModelSelection(asModel(resolved)):null,modelId:body.modelConfigId?String(body.modelConfigId).trim():null,...(body.modelConfigId?{modelConfigId:String(body.modelConfigId).trim()}:{}),workspaceRoot:null};
  try{receipt=await context.rpc('trigger_begin',{manifest,releases:{},config:{derived_skill_ids:[skill.id],derived_skill_versions:{[skill.id]:[selected.version]}}}) as typeof receipt;}catch(error){if((error as {status?:number}).status===409){const latest=await context.rpc('trigger_draft_refs',{skill_name:skillName}) as {drafts:Array<{set_id:string;status:string}>};if(!Array.isArray(latest?.drafts))throw fail('Draft conflict binding unavailable',503);const active=latest.drafts.find(row=>row.status==='running');const current=active?await storage.findTriggerEvalSetById(active.set_id):await storage.findFreshDraftingSet(context.actor.username,skillName);if(current)throw Object.assign(error as object,{set:current});}throw error;}
 }
 if(!receipt?.experiment_id||!receipt.set?.id)throw fail('Durable draft work unavailable',503);
 const value=await context.rpc('trigger_draft_read',{experiment_id:receipt.experiment_id}) as DraftValue;
 const current=await storage.findTriggerEvalSetById(receipt.set.id);
 if(!current){await cancelDraft(context,receipt.experiment_id);throw fail('Draft placeholder was deleted',410);}
 if(value.status==='cancelled')throw fail('Draft was cancelled',410);
 const finalized=await finalizeCoreTriggerDraft(context,receipt.experiment_id);
 if(value.status==='running'){
  if(current.status!=='drafting'||current.updatedAt!==receipt.set.updatedAt||!storage.sameTriggerItems(current.items,receipt.set.items))throw fail('Draft placeholder changed before execution',409);
  const {activateExperimentWork}=await import('./experiment-worker');void activateExperimentWork(context,receipt.experiment_id,{concurrency:1}).catch(error=>console.error('[CORE_TRIGGER_DRAFT]',error));
 }
 return Response.json({success:true,set:finalized||current});
}
async function cancelDraft(context:CoreExperimentContext,id:string,deleting=false){
 let value=await context.rpc(deleting?'trigger_delete_draft':'trigger_cancel',{run_id:id}) as {cancellation_id:string|null;targets:Row[]};if(!Array.isArray(value?.targets))throw fail('Draft cancellation unavailable',503);
 const {stopCoreEvaluationAttempt}=await import('./experiment-worker');
 for(const target of value.targets.filter(row=>row.confirmed!==true)){const proof=await stopCoreEvaluationAttempt(context,target as unknown as import('./experiment-worker').CoreEvaluationTarget);value=await context.rpc(deleting?'trigger_delete_draft_cleanup':'trigger_cleanup',{run_id:id,cancellation_id:value.cancellation_id,proof}) as typeof value;}
}
export async function deleteCoreTriggerSets(skillName:string):Promise<boolean>{
 const context=requireCoreExperimentContext(),storage=await import('@/server/skill_trigger_eval_storage');const deleted=await storage.deleteTriggerEvalSet(context.actor.username,skillName);
 const refs=await context.rpc('trigger_draft_refs',{skill_name:skillName}) as {drafts:Array<{experiment_id:string;set_id:string;status:string}>};if(!Array.isArray(refs?.drafts))throw fail('Draft reference coverage unavailable',503);
 for(const ref of refs.drafts)if(['running','cancelled'].includes(ref.status)&&!(await storage.findTriggerEvalSetById(ref.set_id)))await cancelDraft(context,ref.experiment_id,true);
 return deleted;
}
