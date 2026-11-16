import {freezeModelSelection} from './frozen-model';
import {createHash} from 'node:crypto';
import {presetEvaluators} from '@/lib/evaluators/preset-evaluators';
import {freezeCoreEvaluators,runWithCoreEvaluatorActor} from './evaluators';
import {runWithCoreDatasetActor,requireCoreDatasetContext} from './datasets';
import {findAgentDataset} from '@/server/agent_datasets_storage';
import {getActiveConfig} from '@/lib/storage/server-config';
import type {CoreExperimentContext} from './experiments';
import {experimentSkillSource} from './experiment-skill-derived';

type ObjectValue=Record<string,unknown>;
function object(value:unknown):ObjectValue {if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('Invalid frozen Experiment configuration'),{status:400});return value as ObjectValue;}
export function evaluatorIdsOf(value:unknown):string[]{const ids=typeof value==='string'?JSON.parse(value):value;if(!Array.isArray(ids)||ids.length>1000||ids.some(id=>typeof id!=='string'||!id))throw Object.assign(new Error('Experiment evaluators required'),{status:400});if(new Set(ids).size!==ids.length)throw Object.assign(new Error('Duplicate Experiment evaluator'),{status:400});return ids as string[];}
export async function freezeExperimentAssets(context:CoreExperimentContext,data:ObjectValue):Promise<ObjectValue>{
 const ids=evaluatorIdsOf(data.evaluatorIdsJson);const builtins=new Map(presetEvaluators.map(card=>[card.id,card]));const customIds=ids.filter(id=>!builtins.has(id));
 const frozen=await runWithCoreEvaluatorActor(context.actor,()=>freezeCoreEvaluators(customIds),context.options);
 const evaluators:ObjectValue={};const releases:Record<string,string>={};
 for(const id of ids){
  const builtin=builtins.get(id);
  if(builtin){const card=JSON.parse(JSON.stringify(builtin));evaluators[id]={card,origin:'builtin',definition_hash:createHash('sha256').update(JSON.stringify(card)).digest('hex'),implementation_version:'experiment-preset/v1'};}
  else{const release=frozen.releases.find(row=>row.evaluator_id===id)!;evaluators[id]={card:frozen.cards[id],...release,origin:'user'};releases['evaluator:'+id]=release.release_id;}
 }
 const snapshot=data.configSnapshotJson?object(JSON.parse(String(data.configSnapshotJson))):{};
 const datasetId=typeof snapshot.agentEvalDatasetId==='string'?snapshot.agentEvalDatasetId:typeof snapshot.datasetId==='string'?snapshot.datasetId:null;
 if(datasetId)await runWithCoreDatasetActor(context.actor,context.request,async()=>{
  const record=await findAgentDataset(context.actor.username,datasetId);if(!record)throw Object.assign(new Error('Experiment Dataset unavailable'),{status:404});
  const dataset=requireCoreDatasetContext().snapshots.get(datasetId);if(!dataset)throw Object.assign(new Error('Sealed Dataset version unavailable'),{status:409});releases.dataset=dataset.release_id;
 },context.options);
 snapshot.customEvaluatorSnapshots={schemaVersion:1,cards:frozen.cards};
 snapshot.coreAssets={schemaVersion:1,evaluators,releases};
 return {...data,configSnapshotJson:JSON.stringify(snapshot)};
}
export function coreExperimentStartOperation(context:Pick<CoreExperimentContext,'operationKey'>,experimentId:string,options:{caseIds?:string[];evaluatorIds?:string[]}={}){
 const selection={case_ids:options.caseIds||null,evaluator_ids:options.evaluatorIds||null};
 const suffix=createHash('sha256').update(JSON.stringify(selection)).digest('hex').slice(0,24);
 return {key:context.operationKey+':start:'+suffix,request:{experiment_id:experimentId,...selection}};
}
export async function prepareCoreExperimentStart(context:CoreExperimentContext,experimentId:string,options:{caseIds?:string[];evaluatorIds?:string[];allowPersistedRunning?:boolean}={}):Promise<{experiment:ObjectValue;payload:ObjectValue}>{
 const found=await context.rpc('read',{experiment_id:experimentId}) as {experiment:ObjectValue;revision:string};
 if(!found?.experiment)throw Object.assign(new Error('Experiment not found'),{status:404});
 let data=found.experiment;let snapshot=data.configSnapshotJson?object(JSON.parse(String(data.configSnapshotJson))):{};
 if(!snapshot.coreAssets){data=await freezeExperimentAssets(context,data);snapshot=object(JSON.parse(String(data.configSnapshotJson)));}
 const operation=coreExperimentStartOperation(context,experimentId,options);
 const assets=object(snapshot.coreAssets);const model=await getActiveConfig(context.actor.username);
 const modelSelection=Object.prototype.hasOwnProperty.call(context,'frozenStartModelSelection')?context.frozenStartModelSelection:freezeModelSelection(model);
 const source=experimentSkillSource(data);let skillConfig:Record<string,unknown>={...await freezeDerivedSkillScope(context,snapshot.coreDirectSkills)};
 if(source&&typeof data.skillName==='string'&&Number.isSafeInteger(data.skillVersion)){
  const {prisma}=await import('@/lib/storage/prisma');
  const skill=await prisma.skill.findFirst({where:{name:data.skillName,OR:[{user:context.actor.username},{user:null},{visibility:'public'}],versions:{some:{version:data.skillVersion as number}}},select:{id:true,name:true,user:true,visibility:true}});
  if(!skill)throw Object.assign(new Error('Experiment Skill version is unavailable'),{status:403});
  const ids=skillConfig.derived_skill_ids as string[];const versions=skillConfig.derived_skill_versions as Record<string,number[]>;
  skillConfig={derived_skill_ids:[...new Set([...ids,skill.id])],derived_skill_versions:{...versions,[skill.id]:[...new Set([...(versions[skill.id]||[]),data.skillVersion as number])]},...(skill.user!==null&&skill.user!==context.actor.username?{derived_public_business_skill_id:skill.id}:{}),experiment_skill_scope:{skill_id:skill.id,skill_name:data.skillName,version:data.skillVersion,source,preset:data.preset??null,scope:data.scope||''}};
 }
 return {experiment:found.experiment,payload:{experiment_id:experimentId,...(options.caseIds?{case_ids:options.caseIds}:{}),...(options.evaluatorIds?{evaluator_ids:options.evaluatorIds}:{}),expected_revision:found.revision,releases:object(assets.releases),frozen_evaluators:object(assets.evaluators),config:{model_selection:modelSelection,...skillConfig},operation_key:operation.key,operation_request:operation.request}};
}

export async function startCoreExperiment(context:CoreExperimentContext,experimentId:string,options:{caseIds?:string[];evaluatorIds?:string[];allowPersistedRunning?:boolean}={}):Promise<unknown>{
 const prepared=await prepareCoreExperimentStart(context,experimentId,options);
 if(options.allowPersistedRunning&&prepared.experiment.status==='running')return prepared.experiment;
 return context.rpc('start',prepared.payload);
}

export async function freezeDirectTrajectoryAssets(context:CoreExperimentContext,data:ObjectValue,metadata:ObjectValue):Promise<ObjectValue>{
 const selected=Array.isArray(metadata.selectedEvaluators)?metadata.selectedEvaluators.filter((id):id is string=>typeof id==='string'):[];
 const customIds=[...new Set(selected.filter(id=>id.startsWith('custom-')))];const frozen=await runWithCoreEvaluatorActor(context.actor,()=>freezeCoreEvaluators(customIds),context.options);
 const ids=typeof data.evaluatorIdsJson==='string'?JSON.parse(data.evaluatorIdsJson):['__direct_trajectory__'];
 if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!(id==='__direct_trajectory__'||id.startsWith('__direct_trajectory__:'))))throw Object.assign(new Error('Invalid internal trajectory evaluator slots'),{status:400});
 const evaluators:ObjectValue={};const releases:Record<string,string>={};
 for(const id of ids){const card={id,name:'原轨迹评测执行器',source:'internal',implementation_version:'direct-trajectory/v1'};evaluators[id]={card,origin:'internal',definition_hash:createHash('sha256').update(JSON.stringify(card)).digest('hex'),implementation_version:'direct-trajectory/v1'};}
 for(const item of frozen.releases)releases['evaluator:'+item.evaluator_id]=item.release_id;
 const snapshot=data.configSnapshotJson?object(JSON.parse(String(data.configSnapshotJson))):{};
 const allowed=Array.isArray(metadata.allowedDatasetIds)&&metadata.allowedDatasetIds.length?new Set(metadata.allowedDatasetIds.filter((id):id is string=>typeof id==='string')):null;
 const datasets=await runWithCoreDatasetActor(context.actor,context.request,async()=>{
  const {readUserAgentDatasets}=await import('@/server/agent_datasets_storage');const all=await readUserAgentDatasets(context.actor.username);const values=[];
  for(const candidate of all){
   if(allowed&&!allowed.has(candidate.id))continue;
   if(candidate.generationSource==='trace'&&candidate.generationStatus!=='published')continue;
   const value=await findAgentDataset(context.actor.username,candidate.id);if(!value)throw Object.assign(new Error('Frozen Dataset source unavailable'),{status:409});
   const bound=requireCoreDatasetContext().snapshots.get(candidate.id);if(!bound)throw Object.assign(new Error('Dataset release unavailable for trajectory freeze'),{status:409});
   releases['dataset:'+candidate.id]=bound.release_id;values.push(value);
  }
  return values;
 },context.options);
 const {prisma}=await import('@/lib/storage/prisma');
 const skillRows=await prisma.skill.findMany({where:{OR:[{user:context.actor.username},{user:null}]},select:{id:true,name:true,user:true,description:true,activeVersion:true,versions:{orderBy:{version:'desc'},select:{id:true,skillId:true,version:true,content:true,semanticVersion:true,createdAt:true}}}}) as Array<{id:string;name:string;user:string|null;description:string|null;activeVersion:number|null;versions:Array<{id:string;skillId:string;version:number;content:string;semanticVersion:string|null;createdAt:Date}>}>;
 const flows=skillRows.length?await prisma.parsedFlow.findMany({where:{skillId:{in:skillRows.map(row=>row.id)},OR:[{user:context.actor.username},{user:null}]}}) as Array<Record<string,unknown>&{skillId:string}>:[];
 const skills=skillRows.map(row=>({...row,parsedFlows:flows.filter(flow=>flow.skillId===row.id)}));
 snapshot.customEvaluatorSnapshots={schemaVersion:1,cards:frozen.cards};snapshot.coreDirectDatasets={datasets};snapshot.coreDirectSkills=skills;
 snapshot.coreAssets={schemaVersion:1,evaluators,releases,directSelectedEvaluators:selected};
 return {...data,user:context.actor.username,configSnapshotJson:JSON.stringify(snapshot)};
}

export async function freezeDerivedSkillScope(context:CoreExperimentContext,raw:unknown):Promise<{derived_skill_ids:string[];derived_skill_versions:Record<string,number[]>}>{
 if(!Array.isArray(raw)||!raw.length)return {derived_skill_ids:[],derived_skill_versions:{}};
 const frozen=raw.map(object);const requested=frozen.map(row=>String(row.id));
 const {prisma}=await import('@/lib/storage/prisma');const actual=await prisma.skill.findMany({where:{id:{in:requested},OR:[{user:context.actor.username},{user:null}]},select:{id:true,versions:{select:{version:true}}}}) as Array<{id:string;versions:Array<{version:number}>}>;
 const available=new Map(actual.map(row=>[row.id,new Set(row.versions.map(version=>version.version))]));const versions:Record<string,number[]>={};
 for(const skill of frozen){const id=String(skill.id);const allowed=available.get(id);if(!allowed)continue;const rows=Array.isArray(skill.versions)?skill.versions.map(object):[];const selected=rows.map(row=>row.version).filter((version):version is number=>Number.isSafeInteger(version)&&allowed.has(version as number));if(selected.length)versions[id]=[...new Set(selected)];}
 return {derived_skill_ids:Object.keys(versions),derived_skill_versions:versions};
}
export async function prepareDirectTrajectoryAppend(context:CoreExperimentContext,existing:ObjectValue,metadata:ObjectValue):Promise<ObjectValue>{
 const previous=existing.configSnapshotJson?object(JSON.parse(String(existing.configSnapshotJson))):{};const assets=object(previous.coreAssets);const priorIds=Array.isArray(assets.directSelectedEvaluators)?assets.directSelectedEvaluators.filter((id):id is string=>typeof id==='string'):[];
 const requested=Array.isArray(metadata.selectedEvaluators)?metadata.selectedEvaluators.filter((id):id is string=>typeof id==='string'):[];const added=requested.filter(id=>!priorIds.includes(id));
 const updated=await freezeDirectTrajectoryAssets(context,{...existing,evaluatorIdsJson:JSON.stringify(added.length?added.map(id=>'__direct_trajectory__:'+id):Object.keys(object(assets.evaluators)))},{...metadata,selectedEvaluators:added});
 const fresh=object(JSON.parse(String(updated.configSnapshotJson)));const nextAssets=object(fresh.coreAssets);const mergedEvaluators={...object(assets.evaluators),...object(nextAssets.evaluators)};
 const oldCustom=object(previous.customEvaluatorSnapshots||{schemaVersion:1,cards:{}});const newCustom=object(fresh.customEvaluatorSnapshots||{schemaVersion:1,cards:{}});
 const originalDatasets=object(previous.coreDirectDatasets||{datasets:[]});const nextDatasets=object(fresh.coreDirectDatasets||{datasets:[]});
 const mergeRecords=(old:unknown,next:unknown)=>{const values=new Map<string,ObjectValue>();for(const row of [...(Array.isArray(next)?next:[]),...(Array.isArray(old)?old:[])]){const value=object(row);values.set(String(value.id),value);}return [...values.values()];};
 const snapshots=mergeRecords(originalDatasets.datasets,nextDatasets.datasets);const skills=mergeRecords(previous.coreDirectSkills,fresh.coreDirectSkills);
 const releases={...object(nextAssets.releases),...object(assets.releases)};
 const configuration={...previous,customEvaluatorSnapshots:{schemaVersion:1,cards:{...object(newCustom.cards),...object(oldCustom.cards)}},coreDirectDatasets:{datasets:snapshots},coreDirectSkills:skills,coreAssets:{...assets,evaluators:mergedEvaluators,releases,directSelectedEvaluators:[...new Set([...priorIds,...requested])]}};
 return {...existing,evaluatorIdsJson:JSON.stringify(Object.keys(mergedEvaluators)),configSnapshotJson:JSON.stringify(configuration)};
}
