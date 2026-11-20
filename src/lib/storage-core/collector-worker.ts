import {withCollectorEffect} from './collector-effect';
import {randomUUID} from 'node:crypto';
import {configuredCoreBackgroundActors,configuredCoreBackgroundActorForUser,type CoreBackgroundActor} from './compat';
import {collectorIdentityForBackgroundActor,withCoreCollectorIdentity,type CoreCollectorIdentity} from './collector-identity';
import {collectorPrivate,writeCoreCollectorRecord,collectorHash,completeCoreCollector} from './collector-entry';
import {withCoreFlowModelDelivery} from './flow-model-delivery';
import {runWithFrozenModelConfiguration,matchesFrozenModelSelection} from './frozen-model';
import {runWithTrustedCoreAgentContext} from '@/lib/engine/general-agent/trusted-context';
import {getUserSettings,type ModelConfig} from '@/lib/storage/server-config';
import {requireCoreExperimentContext,withCoreConfiguredExperiments,withCoreExperiments} from './experiments';
import {postCoreFlowAnalysis} from './flow-analysis';
import {processUploadAsync} from '@/lib/ingest/upload-analysis';
import {isStorageCoreEnabled} from './mode';
import {coreServiceOrigin} from './server';

type Row=Record<string,any>;
interface State {running:boolean;timer?:ReturnType<typeof setInterval>;identities:Map<string,CoreCollectorIdentity>;worker:string;}
const globalKey=Symbol.for('agent-insight.storage-core.collector-worker');const globals=globalThis as unknown as Record<symbol,Map<string,State>>;const states=globals[globalKey] ||= new Map();
function state(){const origin=coreServiceOrigin();let value=states.get(origin);if(!value){value={running:false,identities:new Map(),worker:'collector-'+randomUUID()};states.set(origin,value);}return value;}
async function frozenModel(user:string,selection:Row|null):Promise<ModelConfig|null>{
 if(!selection)return null;const settings=await getUserSettings(user);const config=settings.configs.find(row=>matchesFrozenModelSelection(row,selection));if(!config)throw Object.assign(new Error('Frozen collector model connection changed'),{status:409});return config;
}
async function runJob(identity:CoreCollectorIdentity,job:Row,background?:CoreBackgroundActor){
 let handle={...job.handle};let lost:unknown;const controller=new AbortController();
 const rpc=async(action:string,payload:Row={})=>{
  const name=action==='lookup_operation'?'lookup_checkpoint':action==='check_work'?'check':action;
  const request=action==='lookup_operation'?(payload.operation_request||{}):payload;
  const value=await collectorPrivate(identity,'collector_jobs',{job_action:name,value:{...handle,...request,...payload,event_id:handle.event_id,attempts:handle.attempts,lease_owner:handle.lease_owner}});
  if(name==='checkpoint'||name==='check'||name==='renew')handle={...handle,...value};return value;
 };
 const check=async()=>{if(lost)throw lost;controller.signal.throwIfAborted();await rpc('check');};
 let renew:ReturnType<typeof setInterval>|undefined;
 try{
 renew=setInterval(()=>{void check().catch(error=>{lost=error;controller.abort();});},10000);renew.unref();
 await check();
 if(job.plan.collector_entry?.analysis_requested&&!background){await rpc('finish',{retry:true});return;}
 const model=job.plan.collector_entry?.analysis_requested?await frozenModel(identity.username,job.capture.model_selection??null):null;
 const plan=job.plan;
 const proxy=plan.collector_entry?.kind==='proxy';
 const stored=proxy?null:await collectorPrivate(identity,'preparation_status',job.receipt);const input=proxy?{data:{}}:JSON.parse(stored.operation_request_json);const original=input.data??input;const data={...original,user:identity.username,...(stored?.reservation.task_id?{task_id:stored.reservation.task_id,upload_id:stored.reservation.execution_id}:{})};
 const normalized=plan.normalized??(await import('@/lib/shared/interaction-utils')).normalizeInteractions(data.interactions||[]);const interactions=(input.data??input).interactions||[];
 let stage=0;let response:Row|undefined;const deferredFlows:Array<()=>Promise<unknown>>=[];
 const source={
  check,
  findSkill:async(name:string)=>job.capture.skills?.find((skill:Row)=>skill.name.toLowerCase()===name.toLowerCase())??null,
  save:async(record:Row)=>{await check();return writeCoreCollectorRecord(identity,record,{analysis:false,analysisJob:{...handle},channel:'analysis',receivedAt:null,operationKey:job.handle.event_id+':save:'+(stage++)});},
  dynamic:async(taskId:string)=>{
   deferredFlows.push(async()=>{await check();
   if(background)return withCoreConfiguredExperiments(background,()=>{const context=requireCoreExperimentContext();context.body={mode:'dynamic'};context.operationKey=job.handle.event_id+':flow';return postCoreFlowAnalysis(taskId);});
   return withCoreCollectorIdentity(identity,async(actor,options)=>withCoreExperiments(new Request('http://localhost/internal/collector-flow?'+new URLSearchParams({workspace_id:actor.workspace}),{method:'POST',headers:{authorization:'Bearer '+actor.token,'idempotency-key':job.handle.event_id+':flow','content-type':'application/json'},body:JSON.stringify({mode:'dynamic'})}),()=>postCoreFlowAnalysis(taskId),options));
   });return {success:true};
  },
  complete:async(taskId:string)=>{await check();if(plan.disposition==='thread_only')return;return completeCoreCollector(identity,{task_id:taskId},job.handle.event_id+':complete',handle);},
 };
 const fakeContext={actor:{username:identity.username,principal:identity.principal,workspace:identity.workspace},rpc};
 const fakeWork={handle:{...handle,attempt_id:job.handle.event_id+':'+job.handle.attempts},checkpoint:job.checkpoint||{}};
  await check();
  const execute=async()=>withCoreFlowModelDelivery(fakeContext as any,fakeWork as any,async()=>{
   if(proxy){const {processProxyEnd}=await import('@/lib/ingest/proxy-end');const result=await withCollectorEffect({identity,session:plan.session,endedAt:plan.ended_at_ms,check,save:async(record:Row)=>source.save({...record,interactions:plan.session.interactions}),flow:async(taskId,skill)=>{deferredFlows.push(async()=>{
    if(background)return withCoreConfiguredExperiments(background,()=>{const ctx=requireCoreExperimentContext();ctx.body=skill?{mode:'compare',skill_id:skill.id,skill_version:skill.version,skill_name:skill.name}:{mode:'dynamic'};ctx.operationKey=job.handle.event_id+':flow';return postCoreFlowAnalysis(taskId);});
    return withCoreCollectorIdentity(identity,async(actor,options)=>withCoreExperiments(new Request('http://localhost/internal/proxy-flow?'+new URLSearchParams({workspace_id:actor.workspace}),{method:'POST',headers:{authorization:'Bearer '+actor.token,'idempotency-key':job.handle.event_id+':flow','content-type':'application/json'},body:JSON.stringify(skill?{mode:'compare',skill_id:skill.id,skill_version:skill.version,skill_name:skill.name}:{mode:'dynamic'})}),()=>postCoreFlowAnalysis(taskId),options));
   });return {success:true};}},()=>processProxyEnd(new Request('http://localhost/internal/proxy-end',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(plan.request)}),plan.session.taskId));response={status:result.status,body:await result.json()};
   }
   if(plan.analysis?.needs_internal_judgment){
    const config=plan.analysis.outcome_config;const skill=job.capture.skills?.find((item:Row)=>item.name===data.skill||item.name===config?.skill);const version=config?.skillVersion??data.skill_version??skill?.activeVersion??0;const definition=skill?.versions?.find((item:Row)=>item.version===version)?.content;
    const {judgeAnswer}=await import('@/lib/engine/evaluation/judge');const context=plan.analysis.context_label||data.label||data.skill||data.query||'';
    const result=await judgeAnswer(context,{standard_answer_example:config?.standard_answer,root_causes:config?.root_causes,key_actions:config?.key_actions,skill_definition:definition},data.final_result,identity.username,job.capture.execution_match?.extractedSteps?JSON.parse(job.capture.execution_match.extractedSteps):null);
    Object.assign(data,{answer_score:result.score,is_answer_correct:result.is_correct,judgment_reason:result.reason||'Judged by Evaluation Model',skip_evaluation:false,skip_internal_judgment:true});await source.save(data);
   }
   if(plan.collector_entry?.run_upload_analysis)await processUploadAsync(data,identity.username,normalized,interactions,source);
   await check();
   await runHooks(identity,plan.post_hooks||[]);
   for(const flow of deferredFlows){try{await flow();}catch(error){if((error as Row)?.coreDeliveryUncertain)throw error;console.warn('[CollectorWorker] flow remains available for retry',{event:job.handle.event_id,status:Number((error as Row)?.status)||503});}}
  });
  await runWithFrozenModelConfiguration(identity.username,model,()=>model?runWithTrustedCoreAgentContext({trustedWorkspaceDir:process.cwd(),trustedModel:{providerID:model.provider||'custom',modelID:model.model||'',baseURL:model.baseUrl,apiKey:model.apiKey,headers:model.headers},cancelSignal:controller.signal,recordCoreTrace:async({record})=>{await writeCoreCollectorRecord(identity,{...record,user:identity.username},{analysis:false,channel:'model',operationKey:'collector-model:'+collectorHash(record)});}},execute):execute());
  await rpc('finish',response?{response}:{});
 }catch(error){
  const retry=!!(error as Row)?.coreDeliveryUncertain||![400,401,403,404,409,410,413].includes(Number((error as Row)?.status));
  try{await collectorPrivate(identity,'collector_jobs',{job_action:'finish',value:{...handle,retry}});}catch{}
  if(retry)console.warn('[CollectorWorker] analysis remains pending',{event:job.handle.event_id,status:Number((error as Row)?.status)||503});
 }finally{clearInterval(renew);controller.abort();}
}
async function runHooks(identity:CoreCollectorIdentity,hooks:Row[]){
 const {prismaRaw}=await import('@/lib/storage/prisma');
 for(const hook of hooks){
  await identity.revalidate();
  if(hook.kind==='register_agents')for(const agent of hook.agents||[])await prismaRaw.registeredAgent.upsert({where:{platform_name_user:{user:identity.username,platform:hook.platform,name:agent.name}},create:{name:agent.name,platform:hook.platform,user:identity.username,agentType:agent.agentType||'main',agentOwnership:agent.agentOwnership||'user'},update:{agentType:agent.agentType||'main',agentOwnership:agent.agentOwnership||'user'}});
  else if(hook.kind==='config_key_actions'){
   const current=await prismaRaw.config.findFirst({where:{id:hook.id,user:identity.username}});if(current){const {readConfig}=await import('@/lib/storage/data-service');const actual=(await readConfig(identity.username)).find(item=>item.id===hook.id);if(actual&&JSON.stringify(actual)===JSON.stringify(hook.expected_config))await prismaRaw.config.update({where:{id:hook.id},data:{keyActions:hook.keyActions,extractedKeyActions:hook.extractedKeyActions}});}
  }else if(hook.kind==='normalize_framework_identity_history'){
   await collectorPrivate(identity,'normalize_history',{framework:hook.framework,primary_agent_name:hook.primaryAgentName});
   await prismaRaw.registeredAgent.deleteMany({where:{user:identity.username,platform:hook.framework,name:{not:hook.primaryAgentName}}});await prismaRaw.registeredAgent.updateMany({where:{user:identity.username,platform:hook.framework,name:hook.primaryAgentName},data:{agentType:'main'}});
  }else if(hook.kind==='normalize_legacy_codex_history')await collectorPrivate(identity,'normalize_history',{framework:'codex',codex:true});
  else if(hook.kind==='goal_plus_relink'){const {relinkGoalPlusForExecution}=await import('@/lib/ingest/goal-plus/correlate');await relinkGoalPlusForExecution(identity.username);}
  else if(hook.kind==='collaboration_resolve'){const {resolveCollaborationEndpointsForExecution}=await import('@/lib/ingest/collaboration/resolve');await resolveCollaborationEndpointsForExecution(identity.username,hook.references||[]);}
 }
}
export function kickCoreCollectorWorker(identity?:CoreCollectorIdentity){

 const current=state();if(identity)current.identities.set(identity.workspace+'\0'+identity.principal,identity);
 if(!current.timer){current.timer=setInterval(()=>{void drainCoreCollectorWork().catch(()=>{});},1000);current.timer.unref();}
 void drainCoreCollectorWork().catch(()=>{});
}
export async function drainCoreCollectorWork(){
 const current=state();if(current.running)return;current.running=true;
 try{
  const actors=new Map<string,CoreBackgroundActor>();
  const configured=await configuredCoreBackgroundActors({},true);
  for(const actor of configured.actors){try{
   const key=actor.workspace+'\0'+actor.principal,identity=await collectorIdentityForBackgroundActor(actor,{operation:'snapshot'});
   if(!current.identities.has(key))current.identities.set(key,identity);
   if(!actors.has(key)){try{await collectorPrivate(identity,'model_scope');actors.set(key,actor);current.identities.set(key,identity);}catch(error){if(![401,403].includes(Number((error as Row)?.status)))throw error;}}
  }catch(error){if(![401,403].includes(Number((error as Row)?.status)))throw error;}}
  for(const [key,identity] of current.identities){try{const jobs=await collectorPrivate(identity,'collector_jobs',{job_action:'claim',value:{worker_id:current.worker}});for(const job of jobs)await withCoreCollectorIdentity(identity,()=>runJob(identity,job,actors.get(key)));}catch(error){if(![401,403].includes(Number((error as Row)?.status)))throw error;current.identities.delete(key);}}
 }finally{current.running=false;}
}
export const startCoreCollectorWorker=()=>kickCoreCollectorWorker();
export function stopCoreCollectorWorker(){for(const current of states.values()){if(current.timer)clearInterval(current.timer);current.timer=undefined;current.identities.clear();}}
