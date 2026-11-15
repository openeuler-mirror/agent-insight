import type {PrismaClient} from '@prisma/client';
import {createHash} from 'node:crypto';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {requireCoreExperimentContext} from '@/lib/storage-core/experiments';
import {createExperimentReadView,type ExperimentViewSnapshot} from '@/lib/storage-core/experiment-view';

type Row=Record<string,unknown>;
type Query={where?:Row;select?:Row;orderBy?:Row;take?:number;skip?:number};
function unavailable(message:string,status=503):never{throw Object.assign(new Error(message),{status});}
function parse(value:unknown):Row{if(typeof value!=='string')return {};try{return JSON.parse(value)||{};}catch{return {};}}
function matches(row:Row,where:Row={}):boolean{return Object.entries(where).every(([key,value])=>{if(key==='OR')return (value as Row[]).some(item=>matches(row,item));if(key==='AND')return (value as Row[]).every(item=>matches(row,item));if(value&&typeof value==='object'){const filter=value as Row;if('in'in filter)return (filter.in as unknown[]).includes(row[key]);if('not'in filter)return row[key]!==filter.not;if('lt'in filter)return Number(new Date(String(row[key])))<Number(filter.lt);}return row[key]===value;});}
function select(row:Row,fields?:Row):Row{return fields?Object.fromEntries(Object.entries(fields).filter(([,enabled])=>enabled).map(([key])=>[key,row[key]])):structuredClone(row);}
function hydrate(value:Row){return {...value,createdAt:new Date(String(value.createdAt)),updatedAt:new Date(String(value.updatedAt||value.createdAt))};}
export function projectDirectTrajectoryCase(experiment:Row,item:Row):Row{
 const request=item.directTrajectory as Row;const metadata=parse(request.rawAnalysisJson);
 const selected=Array.isArray(metadata.selectedEvaluators)?metadata.selectedEvaluators as string[]:[];
 const results=(item.results as Row[]||[]).filter(row=>row.evaluatorId==='__direct_trajectory__'||String(row.evaluatorId).startsWith('__direct_trajectory__:')&&selected.includes(String(row.evaluatorId).slice('__direct_trajectory__:'.length)));
 let merged:Row={...request,trajectoryScore:null,dimensionScoresJson:null,deviationStepsJson:null,rootCauseStep:null,reasonText:null,errorMessage:null,executionId:request.executionId??null,taskId:request.taskId??null};const raw:Row={};const custom:Row={};
 for(const result of results){
  if(result.errorMessage)merged.errorMessage=result.errorMessage;
  const evidence=parse(result.evidenceJson);const machine=((evidence.json as Row|undefined)?.directTrajectory||evidence.directTrajectory) as Row|undefined;if(!machine)continue;
  const analysis=parse(machine.rawAnalysisJson);Object.assign(raw,analysis);if(analysis.customEvaluations&&typeof analysis.customEvaluations==='object')Object.assign(custom,analysis.customEvaluations);
  const real=String(result.evaluatorId).slice('__direct_trajectory__:'.length);
  if(result.evaluatorId==='__direct_trajectory__'||real==='preset-agent-trace-quality')merged={...merged,...machine};
  else for(const key of ['datasetId','caseId','errorMessage'])if(machine[key])merged[key]=machine[key];
 }
 const taskResult=results.find(row=>row.evaluatorId==='__direct_trajectory__:preset-agent-task-completion');
 if(taskResult){const packet=parse(taskResult.evidenceJson);const saved=((packet.json as Row|undefined)?.directTrajectory||packet.directTrajectory) as Row|undefined;const analysis=parse(saved?.rawAnalysisJson);for(const key of ['resultEvaluation','resultEvaluationError','resultEvaluationRetry','resultArtifactExtraction','resultActualOutput','diagnostic'])if(key in analysis)raw[key]=analysis[key];}
 if(Object.keys(custom).length){raw.customEvaluations=custom;const scores=Object.values(custom).map(item=>(item as Row).score).filter((value):value is number=>typeof value==='number'&&Number.isFinite(value));raw.customEvaluationScore=scores.length?scores.reduce((a,b)=>a+b,0)/scores.length:null;}
 const hasAll=results.length>=selected.length&&results.length>0;
 let status=!hasAll||results.some(row=>row.status==='running'||row.status==='pending')?results.some(row=>row.status==='running'||row.status==='done')?'running':'pending':results.some(row=>row.status==='failed')?'failed':results.some(row=>row.status==='cancelled')?'failed':'done';
 const trace=results.find(row=>row.evaluatorId==='__direct_trajectory__:preset-agent-trace-quality');
 const customFailure=results.some(row=>String(row.evaluatorId).startsWith('__direct_trajectory__:custom-')&&row.status==='failed');
 if(hasAll&&trace?.status==='done'&&(taskResult?.status!=='failed'||typeof raw.resultEvaluationError==='string')&&!customFailure&&!results.some(row=>['pending','running','cancelled'].includes(String(row.status)))){status='done';merged.errorMessage=null;}
 const watch=Object.fromEntries(Object.entries(metadata).filter(([key])=>['autoWatch','watchedAgent','autoWatchEnabledAt','watchPlaceholder','placeholderOnly'].includes(key)));
 return {...merged,id:item.id,evaluatorRunId:experiment.id,user:experiment.user,status,rawAnalysisJson:JSON.stringify({...metadata,...raw,...watch,selectedEvaluators:metadata.selectedEvaluators,selectedEvaluatorNames:metadata.selectedEvaluatorNames}),createdAt:request.createdAt||item.createdAt,updatedAt:results.map(row=>String(row.updatedAt||'')).sort().at(-1)||experiment.updatedAt};
}
export async function directTrajectorySource<T>(legacy:T):Promise<PrismaClient>{
 if(!isStorageCoreEnabled())return legacy as unknown as PrismaClient;
 const context=requireCoreExperimentContext();
 const response=await context.rpc('read_view',{scope:'trajectory-direct'}) as {coverage:string;snapshots:ExperimentViewSnapshot[]};
 if(response?.coverage!=='complete'||!Array.isArray(response.snapshots))unavailable('Complete direct evaluation snapshot required');
 const ownedWhere=(where:Row={}):Row=>Object.fromEntries(Object.entries(where).filter(([key,value])=>key!=='user'||value!==context.actor.username).map(([key,value])=>[key,['OR','AND'].includes(key)&&Array.isArray(value)?value.map(item=>ownedWhere(item as Row)):value]));
 const snapshots=response.snapshots;const view=createExperimentReadView(snapshots,{actorUsername:context.actor.username});
 const locations=new Map<string,{snapshot:ExperimentViewSnapshot;item:Row}>();let rows:Row[]=[];
 for(const snapshot of snapshots){
  if(snapshot.experiment.scope!=='trajectory-direct')unavailable('Unexpected direct evaluation scope');
  for(const item of snapshot.experiment.cases as Row[]){
   const request=item.directTrajectory as Row|undefined;if(!request)continue;
   const combined=projectDirectTrajectoryCase(snapshot.experiment,item);
   rows.push(hydrate(combined));locations.set(String(item.id),{snapshot,item});
  }
 }
 const findMany=async(query:Query={})=>{
  let found=rows.filter(row=>matches(row,ownedWhere(query.where)));const order=query.orderBy?Object.entries(query.orderBy)[0]:undefined;
  if(order)found=[...found].sort((a,b)=>{const left=a[order[0]];const right=b[order[0]];const diff=left instanceof Date&&right instanceof Date?left.valueOf()-right.valueOf():String(left).localeCompare(String(right));return order[1]==='desc'?-diff:diff;});
  return found.slice(query.skip||0,query.take===undefined?undefined:(query.skip||0)+query.take).map(row=>select(row,query.select));
 };
 let created=0;
 const trajectoryEvalResult={findMany,findFirst:async(query:Query={})=>(await findMany({...query,take:1}))[0]||null,findUnique:async(query:Query={})=>(await findMany({...query,take:1}))[0]||null,
  groupBy:async(query:Query)=>{const groups=new Map<string,Date>();for(const row of rows.filter(item=>matches(item,ownedWhere(query.where)))){const id=String(row.evaluatorRunId);const date=row.createdAt as Date;if(!groups.has(id)||groups.get(id)!>date)groups.set(id,date);}return [...groups].sort((a,b)=>b[1].valueOf()-a[1].valueOf()).slice(query.skip||0,(query.skip||0)+(query.take||groups.size)).map(([evaluatorRunId,createdAt])=>({evaluatorRunId,_min:{createdAt}}));},
  create:async({data}:{data:Row})=>{
   if(data.user!==context.actor.username)unavailable('Direct evaluation actor mismatch',403);
   const run=String(data.evaluatorRunId);let snapshot=snapshots.find(value=>value.experiment.id===run);
   const requestMetadata=parse(data.rawAnalysisJson);
   if(!snapshot){
    const {freezeDirectTrajectoryAssets}=await import('@/lib/storage-core/experiment-assets');
    const taskMeta=requestMetadata.taskMeta as Row|undefined;
    const prepared=await freezeDirectTrajectoryAssets(context,{id:run,name:String(taskMeta?.title||'轨迹评测'),type:'single',scope:'trajectory-direct',skillName:String(taskMeta?.skillName||''),skillVersion:taskMeta?.skillVersion??null,agentName:String(requestMetadata.watchedAgent||''),watchMode:requestMetadata.autoWatch===true,evaluatorIdsJson:JSON.stringify((requestMetadata.selectedEvaluators as string[]).map(id=>'__direct_trajectory__:'+id)),configSnapshotJson:'{}',cases:[]},requestMetadata);
    const payload={experiment:prepared};const result=await context.rpc('create',{...payload,operation_key:`${context.operationKey}:direct-create`,operation_request:{body:context.body,run_id:run}}) as ExperimentViewSnapshot;
    if(!result?.experiment)unavailable('Direct evaluation creation unavailable');snapshot=result;snapshots.push(snapshot);
   }
   else {
    const {prepareDirectTrajectoryAppend}=await import('@/lib/storage-core/experiment-assets');
    for(let attempt=0;attempt<3;attempt++){
     const prepared=await prepareDirectTrajectoryAppend(context,snapshot.experiment,requestMetadata);
     if(prepared.configSnapshotJson===snapshot.experiment.configSnapshotJson&&prepared.evaluatorIdsJson===snapshot.experiment.evaluatorIdsJson)break;
     const changes={evaluatorIdsJson:prepared.evaluatorIdsJson,configSnapshotJson:prepared.configSnapshotJson};const payload={experiment_id:run,changes,expected_revision:(snapshot as unknown as {revision?:string}).revision};
     try{const updated=await context.rpc('update',{...payload,operation_key:context.operationKey+':direct-append-assets',operation_request:{body:context.body,run_id:run,selected_evaluators:requestMetadata.selectedEvaluators}}) as ExperimentViewSnapshot;if(!updated?.experiment)unavailable('Extended direct evaluation assets unavailable');snapshot=updated;break;}
     catch(error){if((error as {status?:number}).status!==409||attempt===2)throw error;snapshot=await context.rpc('read',{experiment_id:run}) as ExperimentViewSnapshot;}
    }
   }
   const config=parse(snapshot.experiment.configSnapshotJson);
   requestMetadata.customEvaluatorSnapshots=config.customEvaluatorSnapshots;
   delete requestMetadata.frozenTraceDataset;
   const frozenDatasets=(config.coreDirectDatasets as {datasets?:Row[]}|undefined)?.datasets||[];
   const bound=frozenDatasets.find(dataset=>dataset.id===data.datasetId);
   if(bound)requestMetadata.frozenTraceDataset={id:bound.id,name:bound.name,cases:bound.cases};
   data={...data,rawAnalysisJson:JSON.stringify(requestMetadata)};
   const index=created++;const identity='direct-'+createHash('sha256').update(JSON.stringify([run,data.taskId||data.executionId||'placeholder',context.operationKey,index])).digest('hex');
   const now=new Date().toISOString();const dto={...data,id:identity,createdAt:now,updatedAt:now};
   const item={id:identity,input:'',actualOutput:'',taskId:data.taskId||null,executionId:data.executionId||null,groupId:identity,directTrajectory:dto};
   const payload={experiment_id:run,case:item};const saved=await context.rpc('case_upsert',{...payload,operation_key:`${context.operationKey}:direct-case:${identity}`,operation_request:{body:context.body,run_id:run,index,task_id:data.taskId||null,execution_id:data.executionId||null,dataset_id:data.datasetId||null,case_id:data.caseId||null}}) as {experiment?:{cases?:Row[]}};
   const stored=saved.experiment?.cases?.find(row=>row.id===identity);const stable=(stored?.directTrajectory as Row|undefined)||dto;
   locations.set(identity,{snapshot,item:stored||item});const row=hydrate(stable);rows.push(row);return structuredClone(row);
  },
  update:async({where,data}:{where:Row;data:Row})=>{
   if(Object.keys(data).some(key=>key!=='rawAnalysisJson'))unavailable('Direct evaluation machine results are immutable');
   const location=locations.get(String(where.id));if(!location)unavailable('Direct evaluation result not found',404);
   const original=location.item.directTrajectory as Row;const metadata=parse(original.rawAnalysisJson);const incoming=parse(data.rawAnalysisJson);
   for(const key of ['autoWatch','watchedAgent','autoWatchEnabledAt']){delete metadata[key];if(incoming[key]!==undefined)metadata[key]=incoming[key];}
   const request={...original,rawAnalysisJson:JSON.stringify(metadata)};const payload={experiment_id:location.snapshot.experiment.id,case:{id:location.item.id,directTrajectory:request}};
   await context.rpc('case_upsert',{...payload,operation_key:`${context.operationKey}:direct-metadata:${where.id}`,operation_request:payload});
   if(location.snapshot.experiment.watchMode!==(incoming.autoWatch===true)||location.snapshot.experiment.agentName!==String(incoming.watchedAgent||'')){
    const changes={watchMode:incoming.autoWatch===true,agentName:String(incoming.watchedAgent||'')};const update={experiment_id:location.snapshot.experiment.id,changes};await context.rpc('update',{...update,operation_key:context.operationKey+':direct-watch:'+location.snapshot.experiment.id,operation_request:update});Object.assign(location.snapshot.experiment,changes);
   }
   location.item.directTrajectory=request;const row=rows.find(row=>row.id===where.id)!;Object.assign(row,data);return structuredClone(row);
  },
  deleteMany:async({where}:{where:Row})=>{
   const selected=rows.filter(row=>matches(row,ownedWhere(where)));if(selected.some(row=>row.status==='pending'||row.status==='running'))unavailable('评测/执行进行中，无法删除',409);
   for(const row of selected){const location=locations.get(String(row.id))!;const payload={experiment_id:location.snapshot.experiment.id,case_id:row.id};await context.rpc('case_remove',{...payload,operation_key:`${context.operationKey}:direct-remove:${row.id}`,operation_request:payload});}
   rows=rows.filter(row=>!selected.includes(row));return {count:selected.length};
  },
 };
 return new Proxy(view,{get(target,key){if(key==='trajectoryEvalResult')return trajectoryEvalResult;if(key==='$transaction')return (operations:Promise<unknown>[])=>Promise.all(operations);return Reflect.get(target,key);}}) as PrismaClient;
}
