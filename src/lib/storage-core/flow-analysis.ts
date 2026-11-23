import {createHash} from 'node:crypto';
import {prismaRaw,db} from '@/lib/storage/prisma';
import {analyzeDynamicOnly,analyzeExecutionMatch,parseSkillFlow,type ExecutionMatchResult} from '@/lib/engine/observability/flow-parser';
import {computeFrozenAlignmentAttribution,readLlmToolRedundancy,type FrozenAlignmentSources} from '@/lib/engine/evaluation/alignment-attribution';
import {deriveOptPointArtifacts} from '@/lib/engine/evaluation/derive-skill-opt-points';
import {requireCoreExperimentContext,type CoreExperimentContext} from '@/lib/storage-core/experiments';
import {withCoreFlowModelDelivery} from '@/lib/storage-core/flow-model-delivery';
import {activateExperimentWork,type FrozenExperimentWork} from '@/lib/storage-core/experiment-worker';
import {readTraceEvidence,type TraceEvidenceValue} from '@/lib/storage-core/evidence';
import {freezeModelSelection} from '@/lib/storage-core/frozen-model';
import {getActiveConfig} from '@/lib/storage/server-config';
import {isModelConnectionReady} from '@/lib/shared/model-connection';
import {getRootSkillFromInteractions} from '@/lib/engine/observability/skill-scope';
import {requestCore} from '@/lib/storage-core/server';
type Row=Record<string,unknown>;
export const CORE_FLOW_SCOPE='trace-flow-analysis';
export const CORE_FLOW_MATCH='__trace_flow_match__';
export const CORE_FLOW_ATTRIBUTION='__trace_flow_attribution__';
interface FlowSkill {id:string;name:string;version:number;content:string;user:string|null;activeVersion:number|null;record_name?:string}
interface QualityReceipt {experiment_id:string;case_id:string;machine_result_id:string;content_hash:string;run_id:string;plan_hash:string}
export interface CoreFlowManifest {version:1;mode:'compare'|'dynamic';request_key:string;request_hash?:string;trace_ref?:string;trace_id:string;trace_snapshot_hash:string;model_selection:Row|null;skill:FlowSkill|null;parsed_flow:{flowJson:string;mermaidCode:string|null}|null;quality_sources?:FrozenAlignmentSources;quality_receipts?:QualityReceipt[];releases?:Record<string,string>}
export interface CoreFlowSelected {experiment_id:string;case_id:string;result_slot_id:string;machine_result_id:string;content_hash:string;run_id:string;created_at:string;manifest:CoreFlowManifest;value:Row}
export interface CoreFlowLookup {match:CoreFlowSelected|null;attribution:CoreFlowSelected|null}
const object=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
function unavailable(message:string,status=503):never{throw Object.assign(new Error(message),{status});}
function businessFailure(message:string):never{throw Object.assign(new Error(message),{coreExperimentFailureResult:{evidence:{json:{coreFlowFailure:{version:1,message}}}}});}
export async function assertCoreFlowSkillAccess(manifest:CoreFlowManifest,user:string){
 if(!manifest.skill)return;
 const allowed=await prismaRaw.skill.findFirst({where:{id:manifest.skill.id,name:manifest.skill.record_name||manifest.skill.name,OR:[{user},{user:null}]},select:{id:true}});
 if(!allowed)unavailable('Frozen flow Skill is no longer accessible',403);
}
export async function computeFrozenCoreFlowWork(work:FrozenExperimentWork,options:{user:string;signal:AbortSignal}){
 const context=requireCoreExperimentContext();if(context.actor.username!==options.user)unavailable('Flow actor differs',403);
 const manifest=(work.runplan.config as Row|undefined)?.core_flow_analysis as CoreFlowManifest|undefined;
 const source=work.frozen_trace_evidence;const sourceManifest=source?.manifest as Row|undefined;
 if(work.experiment_config.scope!==CORE_FLOW_SCOPE||!manifest||manifest.version!==1||!['compare','dynamic'].includes(manifest.mode)||!source?.execution||!Array.isArray(source.session?.interactions))unavailable('Frozen flow inputs are unavailable');
 if(source.snapshot_hash!==manifest.trace_snapshot_hash||sourceManifest?.trace_id!==manifest.trace_id)unavailable('Frozen flow Trace differs',409);
 const execution=source.execution;const interactions=source.session!.interactions as unknown[];
 await assertCoreFlowSkillAccess(manifest,options.user);await assertQualityAccess(context,manifest);options.signal.throwIfAborted();await context.rpc('check_work',work.handle);
 const result=await withCoreFlowModelDelivery(context,work,async()=>{
  if(work.handle.evaluator_id===CORE_FLOW_MATCH){
   if(manifest.mode==='dynamic'){
    const value=await analyzeDynamicOnly(String(execution.id),options.user,{frozen:{session:{interactions:interactions}}});
    if(!value.success)businessFailure(value.error||'Flow analysis failed');
    return {score:null,points:[],evidence:{json:{coreFlowMatch:{version:1,mode:'dynamic',matchJson:JSON.stringify(value.match),staticMermaid:null,dynamicMermaid:value.dynamicMermaid,analysisText:null,flowJson:null,extractedSteps:JSON.stringify(value.extractedSteps),interactionCount:value.interactionCount,matchedAt:new Date().toISOString(),usedSkillName:null,usedSkillVersion:null}}}};
   }
   if(!manifest.skill)unavailable('Frozen flow Skill is required');
   let parsed=manifest.parsed_flow;
   if(!parsed?.flowJson){
    const generated=await parseSkillFlow(manifest.skill.content,manifest.skill.id,manifest.skill.version,options.user,{persist:false});
    if(!generated.success||!generated.flow)businessFailure(generated.error||'Frozen Skill flow could not be parsed');
    parsed={flowJson:JSON.stringify(generated.flow),mermaidCode:generated.mermaidCode||null};
   }
   const value=await analyzeExecutionMatch(String(execution.id),manifest.skill.id,manifest.skill.version,options.user,manifest.skill.name,{frozen:{session:{interactions:interactions},parsedFlow:parsed}});
   if(!value.success||!value.result)businessFailure(value.error||'Flow matching failed');
   return {score:null,points:[],evidence:{json:{coreFlowMatch:{version:1,mode:'compare',matchJson:JSON.stringify(value.result),staticMermaid:value.staticMermaid,dynamicMermaid:value.dynamicMermaid,analysisText:JSON.stringify(value.result.problemSteps),flowJson:value.flow?JSON.stringify(value.flow):null,extractedSteps:value.extractedSteps?JSON.stringify(value.extractedSteps):null,interactionCount:value.interactionCount,matchedAt:new Date().toISOString(),usedSkillName:manifest.skill.name,usedSkillVersion:manifest.skill.version}}}};
  }
  if(work.handle.evaluator_id!==CORE_FLOW_ATTRIBUTION||manifest.mode!=='compare'||!manifest.skill)unavailable('Unsupported internal flow evaluator');
  const required=(work.runplan.config as Row).core_flow_match_source as Row|undefined;
  const selected=await context.rpc('flow_lookup',{trace_ref:manifest.trace_id,experiment_id:work.handle.experiment_id}) as CoreFlowLookup;
  if(!required||!selected.match||['machine_result_id','content_hash','run_id'].some(key=>selected.match![key as keyof CoreFlowSelected]!==required[key]))unavailable('Flow attribution source selection differs',409);
  const match=JSON.parse(String(selected.match.value.matchJson)) as ExecutionMatchResult;
  const artifacts=await computeFrozenAlignmentAttribution({user:options.user,executionId:String(execution.id),execution,match,skillName:manifest.skill.name,skillVersion:manifest.skill.version},manifest.quality_sources||{existingRaw:null,toolRedundancy:null});
  if(!artifacts)return {score:null,points:[],evidence:{json:{coreAlignmentAttribution:{version:1,attribution:null,match_source:required}}}};
  const rowId='flow-attribution-'+createHash('sha256').update(work.handle.attempt_id).digest('hex').slice(0,40);
  const derived=deriveOptPointArtifacts({user:options.user,taskId:artifacts.taskId,runId:'alignment_'+work.handle.experiment_id,trajectoryRow:{id:rowId,deviationStepsJson:artifacts.data.deviationStepsJson as string|null,rootCauseStep:artifacts.data.rootCauseStep as string|null,reasonText:artifacts.data.reasonText as string|null,rawAnalysisJson:JSON.stringify({alignmentAttribution:artifacts.rawAnalysis.alignmentAttribution})},skills:[{name:manifest.skill.name,version:manifest.skill.version}]},{executionId:String(execution.id),lineage:work.handle.attempt_id,skills:[manifest.skill]});
  const score=artifacts.data.trajectoryScore;
  return {score:typeof score==='number'?score*100:null,points:[],evidence:{json:{coreAlignmentAttribution:{version:1,attribution:{rowId:work.handle.result_id,candidateCount:artifacts.candidateCount,writtenIssues:derived.skillIssues.length},match_source:required,data:artifacts.data},directTrajectoryDerived:derived}}};
 });
 options.signal.throwIfAborted();await assertCoreFlowSkillAccess(manifest,options.user);await assertQualityAccess(context,manifest);await context.rpc('check_work',work.handle);return result;
}

async function assertQualityAccess(context:CoreExperimentContext,manifest:CoreFlowManifest){
 for(const reference of manifest.quality_receipts||[]){
  const current=await context.rpc('read',{experiment_id:reference.experiment_id,case_ids:[reference.case_id]}) as {gold_redacted?:boolean;experiment:{cases:Row[]}};
  if(current.gold_redacted||!current.experiment.cases.some(row=>row.id===reference.case_id))unavailable('Frozen quality source is no longer accessible',403);
  const plan=await context.rpc('runplan',{experiment_id:reference.experiment_id,run_id:reference.run_id}) as {plan_hash:string};
  if(plan.plan_hash!==reference.plan_hash)unavailable('Frozen quality source RunPlan differs',409);
 }
}

export async function freezeCoreFlowQuality(context:CoreExperimentContext,evidence:TraceEvidenceValue){
 const profile=await requestCore('/v1/auth/me',{token:context.actor.token},context.options.fetcher||fetch);
 if(profile.data.principal_id!==context.actor.principal||typeof profile.data.username!=='string')unavailable('Quality source principal differs',403);
 const list=await context.rpc('list_view',{task_id:evidence.execution.taskId}) as {coverage:string;snapshots:Array<{experiment:Row}>};
 if(list.coverage!=='complete'||!Array.isArray(list.snapshots))unavailable('Complete quality sources required');
 const cases=list.snapshots.filter(row=>row.experiment.user===profile.data.username).flatMap(row=>(row.experiment.cases as Row[]).map(item=>({head:row.experiment,item}))).sort((a,b)=>String(b.item.createdAt).localeCompare(String(a.item.createdAt)));
 const direct=cases.find(row=>row.head.scope==='trajectory-direct'),ordinary=cases.find(row=>row.head.scope!=='trajectory-direct'&&row.head.scope!==CORE_FLOW_SCOPE);
 const receipts:QualityReceipt[]=[],releases:Record<string,string>={};let existingRaw:Row|null=null,toolRedundancy:FrozenAlignmentSources['toolRedundancy']=null;
 for(const candidate of [direct,ordinary]){
  if(!candidate)continue;
  if(candidate===ordinary&&readLlmToolRedundancy(existingRaw))continue;
  const raw=await context.rpc('read',{experiment_id:candidate.head.id,case_ids:[candidate.item.id]}) as {gold_redacted?:boolean;experiment:{cases:Row[]}};
  if(raw.gold_redacted)unavailable('Private quality source owner required',403);
  const item=raw.experiment.cases.find(row=>row.id===candidate.item.id);if(!item)unavailable('Quality source Case changed',409);
  const result=(item.results as Row[]).find(row=>row.status==='done'&&(candidate===direct?(row.evaluatorId==='__direct_trajectory__'||row.evaluatorId==='__direct_trajectory__:preset-agent-trace-quality'):row.evaluatorId==='preset-agent-trace-quality'));
  if(!result)continue;
  const provenance=result.coreResult as Row|undefined;if(!provenance)unavailable('Selected quality receipt unavailable');
  const reference={experiment_id:String(candidate.head.id),case_id:String(item.id),machine_result_id:String(provenance.machineResultId),content_hash:String(provenance.contentHash),run_id:String(provenance.runId),plan_hash:String(provenance.planHash)};receipts.push(reference);
  const plan=await context.rpc('runplan',{experiment_id:reference.experiment_id,run_id:reference.run_id}) as {plan_hash:string;runplan:{releases:Record<string,string>}};
  if(plan.plan_hash!==reference.plan_hash)unavailable('Quality source RunPlan differs',409);
  for(const [slot,release] of Object.entries(plan.runplan.releases)){const kind=slot.split(':')[0];if(['dataset','evaluator','skill'].includes(kind))releases[kind+':flow-quality:'+reference.run_id+':'+createHash('sha256').update(slot).digest('hex').slice(0,16)]=release;}
  if(candidate===direct){
   const packet=JSON.parse(String(result.evidenceJson||'{}'));const trajectory=packet.json?.directTrajectory||packet.directTrajectory;
   if(typeof trajectory?.rawAnalysisJson==='string')existingRaw=JSON.parse(trajectory.rawAnalysisJson);
  }else{
   const points=JSON.parse(String(result.pointsJson||'[]'));if(!Array.isArray(points))continue;
   const value=(label:string)=>{const point=points.find(row=>row&&row.label===label);return typeof point?.score==='number'?point.score/100:null;};
   const toolChoice=value('工具选择'),redundancy=value('冗余度');if(toolChoice!==null&&redundancy!==null)toolRedundancy={toolChoice,redundancy};
  }
 }
 return {quality_sources:{existingRaw,toolRedundancy},quality_receipts:receipts,releases};
}

async function freezeFlowManifest(context:CoreExperimentContext,reference:string,mode:'compare'|'dynamic',requestHash:string):Promise<CoreFlowManifest>{
 const captured=await readTraceEvidence(context.request,{traceRef:reference},context.options);
 if(captured.username!==context.actor.username)unavailable('Flow source actor differs',403);
 const evidence=captured.evidence;let skill:FlowSkill|null=null,parsed_flow:CoreFlowManifest['parsed_flow']=null;
 if(mode==='compare'){
  const root=getRootSkillFromInteractions(evidence.session.interactions)||((typeof evidence.execution.skill==='string'&&evidence.execution.skill)?{name:evidence.execution.skill,version:typeof evidence.execution.skillVersion==='number'?evidence.execution.skillVersion:null}:null);
  if(!root?.name)unavailable('当前 Trace 的外层主 Agent 未加载 Skill，无法进行主 Skill 流程对齐分析。',400);
  const found=await db.findSkill(root.name,context.actor.username) as {id:string;name:string;user:string|null;activeVersion:number|null;versions:Array<{version:number;content:string}>}|null;
  const full=found?await db.findSkillById(found.id) as typeof found:null;
  if(!found||!full?.versions?.length)unavailable('Skill 未找到或没有版本',400);
  const fallback=full.versions.some(row=>row.version===(full.activeVersion??0))?(full.activeVersion??0):Math.max(...full.versions.map(row=>row.version));
  const version=root.version||fallback;const selected=full.versions.find(row=>row.version===version);if(!selected?.content)unavailable('Skill 版本内容为空',400);
  skill={id:found.id,name:root.name,record_name:found.name,user:found.user,activeVersion:full.activeVersion,version,content:selected.content};
  const parsed=await db.findParsedFlow(skill.id,version,context.actor.username) as {flowJson:string|null;mermaidCode:string|null}|null;
  if(parsed?.flowJson){try{JSON.parse(parsed.flowJson);parsed_flow={flowJson:parsed.flowJson,mermaidCode:parsed.mermaidCode};}catch{}}
 }
 const model=await getActiveConfig(context.actor.username);if(!model||!isModelConnectionReady(model))unavailable('请在首页左上角的设置中配置 LLM');
 return {version:1,mode,request_key:context.operationKey,request_hash:requestHash,trace_ref:reference,trace_id:evidence.manifest.trace_id,trace_snapshot_hash:evidence.snapshot_hash,model_selection:freezeModelSelection(model),skill,parsed_flow,...(mode==='compare'?await freezeCoreFlowQuality(context,evidence):{})};
}

function selectedDTO(selected:CoreFlowSelected){
 const value=selected.value;
 if(!['dynamic','compare'].includes(String(value.mode))||typeof value.matchJson!=='string'||!Number.isSafeInteger(value.interactionCount)||Number(value.interactionCount)<0)unavailable('Flow selected DTO is incomplete');
 return value;
}
function postDTO(selected:CoreFlowSelected,attribution:CoreFlowSelected|null){
 const value=selectedDTO(selected);
 if(value.mode==='dynamic')return {success:true,mode:'dynamic',dynamicMermaid:value.dynamicMermaid,interactionCount:value.interactionCount};
 return {success:true,mode:'compare',match:JSON.parse(value.matchJson as string),staticMermaid:value.staticMermaid,dynamicMermaid:value.dynamicMermaid,flowJson:value.flowJson??undefined,extractedSteps:value.extractedSteps??undefined,interactionCount:value.interactionCount,usedSkillName:value.usedSkillName,usedSkillVersion:value.usedSkillVersion,attribution:attribution?.value.attribution??null};
}
async function cacheParsedFlow(selected:CoreFlowSelected,user:string){
 const {manifest,value}=selected;if(manifest.parsed_flow||!manifest.skill||typeof value.flowJson!=='string')return;
 const frozen=manifest.skill;
 await prismaRaw.$transaction(async tx=>{
  const skill=await tx.skill.findFirst({where:{id:frozen.id,OR:[{user},{user:null}],versions:{some:{version:frozen.version,content:frozen.content}}},select:{id:true}});if(!skill)return;
  const where={skillId:frozen.id,version:frozen.version,user};const old=await tx.parsedFlow.findFirst({where});
  if(old?.flowJson){try{JSON.parse(old.flowJson);return;}catch{}}
  const data={flowJson:value.flowJson as string,mermaidCode:typeof value.staticMermaid==='string'?value.staticMermaid:null,parsedAt:new Date()};
  if(old)await tx.parsedFlow.updateMany({where:{id:old.id,flowJson:old.flowJson,mermaidCode:old.mermaidCode},data});else await tx.parsedFlow.create({data:{...where,...data}});
 });
}

export async function postCoreFlowAnalysis(reference:string){
 const context=requireCoreExperimentContext();const mode=context.body.mode==='dynamic'?'dynamic':'compare';
 const requestHash=createHash('sha256').update(JSON.stringify({reference,mode})).digest('hex');
 const identity='flow-'+createHash('sha256').update(JSON.stringify([context.actor.workspace,context.actor.principal,new URL(context.request.url).pathname,context.operationKey])).digest('hex').slice(0,40);
 type StoredFlow={experiment:Row;revision:string};let stored:StoredFlow|null=null;
 try{stored=await context.rpc('read',{experiment_id:identity,include_cases:false}) as StoredFlow;}catch(error){if((error as {status?:number}).status!==404)throw error;}
 if(!stored){
  const manifest=await freezeFlowManifest(context,reference,mode,requestHash);const slots=mode==='compare'?[CORE_FLOW_MATCH,CORE_FLOW_ATTRIBUTION]:[CORE_FLOW_MATCH];
  const evaluators=Object.fromEntries(slots.map(id=>[id,{origin:'internal',implementation_version:'trace-flow/v1',card:{id,name:'Trace flow analysis',source:'internal'}}]));
  const experiment={id:identity,name:'Trace flow analysis',type:'single',scope:CORE_FLOW_SCOPE,skillName:manifest.skill?.name||'',skillVersion:manifest.skill?.version??null,evaluatorIdsJson:JSON.stringify(slots),evaluatorConfigsJson:'{}',configSnapshotJson:JSON.stringify({coreFlowAnalysis:manifest,coreAssets:{schemaVersion:1,evaluators,releases:manifest.releases||{}}}),cases:[{id:identity+'-case',executionId:manifest.trace_id,taskId:manifest.trace_id,input:'',actualOutput:''}]};
  stored=await context.rpc('create',{experiment,operation_key:identity+':create',operation_request:{request_hash:requestHash,scope:CORE_FLOW_SCOPE}}) as StoredFlow;
 }
 if(!stored?.experiment||stored.experiment.scope!==CORE_FLOW_SCOPE)unavailable('Flow request reservation differs',409);
 const snapshot=JSON.parse(String(stored.experiment.configSnapshotJson));const manifest=snapshot.coreFlowAnalysis as CoreFlowManifest;
 if(manifest.version!==1||manifest.request_hash!==requestHash||manifest.trace_ref!==reference||manifest.mode!==mode)unavailable('Flow operation key has different input',409);
 await assertCoreFlowSkillAccess(manifest,context.actor.username);await assertQualityAccess(context,manifest);
 let selected=await context.rpc('flow_lookup',{trace_ref:manifest.trace_id,experiment_id:identity}) as CoreFlowLookup;
 const stage=async(slot:string,source?:CoreFlowSelected)=>{
  const config={core_flow_analysis:manifest,model_selection:manifest.model_selection,derived_skill_ids:manifest.skill?[manifest.skill.id]:[],derived_skill_versions:manifest.skill?{[manifest.skill.id]:[manifest.skill.version]}:{},...(source?{core_flow_match_source:{machine_result_id:source.machine_result_id,content_hash:source.content_hash,run_id:source.run_id}}:{})};
  await context.rpc('start',{experiment_id:identity,case_ids:[identity+'-case'],evaluator_ids:[slot],frozen_evaluators:snapshot.coreAssets.evaluators,releases:snapshot.coreAssets.releases,config,operation_key:identity+':'+slot+':start',operation_request:{request_hash:requestHash,stage:slot}});
  await activateExperimentWork(context,identity);
 };
 if(!selected.match){await stage(CORE_FLOW_MATCH);selected=await context.rpc('flow_lookup',{trace_ref:manifest.trace_id,experiment_id:identity}) as CoreFlowLookup;}
 if(!selected.match){
  const current=await context.rpc('read',{experiment_id:identity}) as StoredFlow;
  for(const row of (current.experiment.cases as Row[]||[]).flatMap(item=>item.results as Row[]||[])){
   if(row.evaluatorId!==CORE_FLOW_MATCH||row.status!=='failed'||!object(row.coreResult)||typeof row.evidenceJson!=='string')continue;
   const marker=JSON.parse(row.evidenceJson)?.json?.coreFlowFailure;
   if(marker?.version===1&&typeof marker.message==='string'&&marker.message===row.errorMessage){
    await assertCoreFlowSkillAccess(manifest,context.actor.username);await assertQualityAccess(context,manifest);
    throw Object.assign(new Error(marker.message),{status:500,coreFlowBusinessError:true});
   }
  }
  unavailable('Flow matching is not completed');
 }
 await cacheParsedFlow(selected.match,context.actor.username).catch(()=>{});
 if(mode==='compare'&&!selected.attribution){
  try{await stage(CORE_FLOW_ATTRIBUTION,selected.match);}
  catch(error){if([401,403,404,409,410].includes((error as {status?:number}).status||0))throw error;}
 }
 selected=await context.rpc('flow_lookup',{trace_ref:manifest.trace_id,experiment_id:identity}) as CoreFlowLookup;
 await assertCoreFlowSkillAccess(manifest,context.actor.username);await assertQualityAccess(context,manifest);
 if(!selected.match)unavailable('Flow match selection changed',409);return postDTO(selected.match,selected.attribution);
}

export async function getCoreFlowAnalysis(reference:string){
 const context=requireCoreExperimentContext();const {evidence}=await readTraceEvidence(context.request,{traceRef:reference},context.options);
 const selected=await context.rpc('flow_lookup',{trace_ref:evidence.manifest.trace_id}) as CoreFlowLookup;
 if(!selected.match)return {analyzed:false,message:'Execution not analyzed yet'};
 await assertCoreFlowSkillAccess(selected.match.manifest,context.actor.username);await assertQualityAccess(context,selected.match.manifest);
 const value=selectedDTO(selected.match);const currentInteractionCount=evidence.session.interactions.length;
 return {analyzed:true,mode:value.mode,matchJson:value.matchJson,staticMermaid:value.staticMermaid??null,dynamicMermaid:value.dynamicMermaid??null,analysisText:value.analysisText??null,flowJson:value.flowJson??null,extractedSteps:value.extractedSteps??null,interactionCount:value.interactionCount,currentInteractionCount,hasUpdate:currentInteractionCount>Number(value.interactionCount),matchedAt:value.matchedAt,usedSkillName:value.usedSkillName??null,usedSkillVersion:value.usedSkillVersion??null};
}
