import {projectCoreBatchDatasetTask} from './batch-dataset';
import {prisma} from '@/lib/storage/prisma';
import {requireCoreExperimentContext,lookupCoreExperimentOperation} from './experiments';
import {activateExperimentWork} from './experiment-worker';
import {coreExperimentStartOperation} from './experiment-assets';
import {readTraceEvidence} from './evidence';
import {ensureEvalExperiment,addEvalExperimentCase,startEvalExperimentCases} from '@/lib/engine/experiment/run-experiment';
import {cancelCoreExperimentExecution} from './experiment-cancellation';

interface Config {
 sourceMode?:string;agentMaxConcurrency?:number;skillId?:string;versionId?:string;evalExperimentId?:string;
 evaluationBatchId?:string;evaluationBatchEvaluators?:string[];evaluators?:string[];evaluatorId?:string;
 coreTraceBindings?:Record<string,string>;
 coreTraceOperation?:{key:string;caseIds:string[];action:string;phase:'prepared'|'submitted'};
 [key:string]:unknown;
}
interface State {status:string;input?:string;sessionId?:string;error?:string;score?:number;timeCost?:string;startedAt?:number;completedAt?:number;[key:string]:unknown}
interface Batch {id:string;user:string;configJson:string;caseStatesJson:string;traceEvalStatesJson?:string}
interface Result {evaluatorId:string;status:string;score?:number|null;errorMessage?:string|null;coreResult?:unknown;coreWork?:{createdAt?:string;startedAt?:string|null;finishedAt?:string|null};createdAt?:string;updatedAt?:string}
interface Experiment {id:string;user:string;status:string;skillName?:string;skillVersion?:number|null;evaluatorIdsJson?:string;deletedAt?:string;cases:Array<{id:string;taskId?:string;deletedAt?:string;results?:Result[]}>}
const failure=(message:string,status:number)=>Object.assign(new Error(message),{status});
async function ownedExperiment(id:string):Promise<Experiment>{
 const context=requireCoreExperimentContext();const found=await context.rpc('read',{experiment_id:id}) as {gold_redacted?:boolean;experiment?:Experiment};
 if(!found.experiment)throw failure('Batch Experiment unavailable',404);
 if(found.gold_redacted===true)throw failure('Batch Experiment belongs to another actor',403);
 return found.experiment;
}
export async function assertCoreBatchScope(operation:string,experimentId?:string):Promise<{lifecycle?:string}>{
 if(!['read','create','patch','abort','evaluate','retry-evaluate','start','retry-execute'].includes(operation))throw failure('Unknown action',400);
 const context=requireCoreExperimentContext();const result=await context.rpc('batch_scope',{operation,...(experimentId?{experiment_id:experimentId}:{})}) as {authorized?:boolean;operation?:string;principal_id?:string;workspace_id?:string;experiment_id?:string;lifecycle?:string};
 if(result?.authorized!==true||result.operation!==operation||result.principal_id!==context.actor.principal||result.workspace_id!==context.actor.workspace)throw failure('Batch capability scope unavailable',403);
 if(experimentId&&(result.experiment_id!==experimentId||!['active','deleted'].includes(result.lifecycle||'')))throw failure('Batch lifecycle scope unavailable',503);
 return result;
}
function requireOwner(user:string){if(user!==requireCoreExperimentContext().actor.username)throw failure('Batch actor differs',403);}
export async function projectCoreBatchTask<T extends {user:string;configJson:object;caseStatesJson:object;traceEvalStatesJson?:object}>(task:T):Promise<T|null>{
 requireOwner(task.user);await assertCoreBatchScope('read');const config=task.configJson as Config;
 if(config.sourceMode!=='trace')return projectCoreBatchDatasetTask(task);
 if(config.evalExperimentId&&(await assertCoreBatchScope('read',config.evalExperimentId)).lifecycle==='deleted')return null;
 const experiment=config.evalExperimentId?await ownedExperiment(config.evalExperimentId):undefined;
 if(experiment?.deletedAt)return null;
 const expected:string[]=experiment?JSON.parse(experiment.evaluatorIdsJson||'[]'):[];
 const states:Record<string,State>={};
 for(const key of new Set([...Object.keys(task.caseStatesJson),...Object.keys(config.coreTraceBindings||{})])){
  const old=((task.caseStatesJson as Record<string,State>)[key]||{}) as State;const state:State={status:'pending',...(typeof old.input==='string'?{input:old.input}:{})};
  const row=experiment?.cases.find(item=>item.id===config.coreTraceBindings?.[key]&&!item.deletedAt);
  if(row?.taskId)state.sessionId=row.taskId;
  if(row){
   const rows=expected.map(id=>row.results?.find(value=>value.evaluatorId===id)).filter((value):value is Result=>!!value);
   const selected=rows.filter(value=>value.coreResult&&['done','failed'].includes(value.status));
   if(expected.length&&selected.length===expected.length){
    const done=selected.filter(value=>value.status==='done'&&typeof value.score==='number'&&Number.isFinite(value.score));
    state.status=done.length?'pass':'fail';
    if(done.length)state.score=Math.round(done.reduce((sum,value)=>sum+value.score!,0)/done.length);
    else state.error=selected.find(value=>value.errorMessage)?.errorMessage||'评测失败';
    const finished=selected.map(value=>Date.parse(value.coreWork?.finishedAt||'')).filter(Number.isFinite);
    if(finished.length)state.completedAt=Math.max(...finished);
   }else if(experiment?.status==='cancelled'||rows.some(value=>value.status==='cancelled')){state.status='fail';state.error='用户终止';
    const finished=rows.map(value=>Date.parse(value.coreWork?.finishedAt||'')).filter(Number.isFinite);if(finished.length)state.completedAt=Math.max(...finished);}
   else if(rows.some(value=>['pending','running'].includes(value.status)))state.status='evaluating';
   const began=rows.map(value=>Date.parse(value.coreWork?.createdAt||'')).filter(Number.isFinite);
   if(began.length)state.startedAt=Math.min(...began);
  }
  states[key]=state;
 }
 const traceStates:Record<string,Record<string,unknown>>={};
 for(const [key,raw] of Object.entries(task.traceEvalStatesJson||{})){
  const source=(raw as {taskId?:string}).taskId;const current=source?Object.values(states).find(value=>value.sessionId===source):undefined;
  traceStates[key]={status:current?.status==='pass'?'done':current?.status==='fail'?'fail':current?.status==='evaluating'?'evaluating':'idle',...(current?.sessionId?{taskId:current.sessionId}:{}),...(typeof current?.score==='number'?{score:current.score}:{})};
 }
 return {...task,caseStatesJson:states,...(task.traceEvalStatesJson!==undefined?{traceEvalStatesJson:traceStates}:{})};
}
function evaluatorIds(config:Config){return config.evaluationBatchId&&config.evaluationBatchEvaluators?.length?config.evaluationBatchEvaluators:config.evaluators?.length?config.evaluators:config.evaluatorId?[config.evaluatorId]:['preset-agent-task-completion'];}
export async function startCoreBatchTrace(task:Batch,selected:string[],retry=false):Promise<void>{
 requireOwner(task.user);await assertCoreBatchScope(retry?'retry-evaluate':'evaluate');const context=requireCoreExperimentContext();const config:Config=JSON.parse(task.configJson||'{}');
 if(config.sourceMode!=='trace')throw failure('Trace source mode required',400);
 const ids=[...new Set(selected.map(String).map(value=>value.trim()).filter(Boolean))];
 if(!ids.length||retry&&ids.length!==1)throw failure('Trace selection required',400);
 const states:Record<string,State>=JSON.parse(task.caseStatesJson||'{}');
 if(retry&&(!states[ids[0]]?.sessionId))throw failure('retry-evaluate requires existing sessionId',400);
 let skillName='';let skillVersion:number|null=null;
 if(config.skillId){
  if(!config.versionId)throw failure('selected skill version is required',400);
  const skill=await prisma.skill.findFirst({where:{id:config.skillId,user:task.user},select:{name:true}});
  if(!skill)throw failure('selected skill not found',404);
  const version=await prisma.skillVersion.findFirst({where:{id:config.versionId,skillId:config.skillId},select:{version:true}});
  if(!version)throw failure('selected skill version not found',404);
  skillName=skill.name;skillVersion=version.version;
 }
 const previous=config.evalExperimentId?await ownedExperiment(config.evalExperimentId):undefined;
 for(const experiment of [previous,...(config.evaluationBatchId?[await ownedExperiment(config.evaluationBatchId)]:[])]){
  if(experiment&&(String(experiment.skillName||'')!==skillName||(experiment.skillVersion??null)!==skillVersion))throw failure('evaluation task belongs to a different skill or version',409);
 }
 const action=retry?'retry-evaluate':'evaluate';
 const boundIds=ids.map(id=>config.coreTraceBindings?.[id]);const prior=config.coreTraceOperation;
 const same=!!prior&&prior.action===action&&JSON.stringify(prior.caseIds)===JSON.stringify(boundIds);
 const anyActive=previous?.cases.some(row=>row.results?.some(value=>['pending','running'].includes(value.status)));
 if(anyActive&&!(same&&(prior!.phase==='prepared'||prior!.key===context.operationKey)))throw failure('task is already running',409);
 const sources=[];
 for(const id of ids){
  const bound=previous?.cases.find(row=>row.id===config.coreTraceBindings?.[id]);
  const sourceId=retry?(bound?.taskId||states[id].sessionId!):id;
  const {evidence}=await readTraceEvidence(context.request,{taskId:sourceId},context.options);
  if(evidence.manifest.owner_principal_id!==context.actor.principal)throw failure('Trace source belongs to another actor',403);
  if(evidence.execution.taskId!==sourceId)throw failure('Trace source differs',409);
  sources.push({id,evidence});
 }
 // The full task ID keeps recovery independent of a possibly lost static binding update.
 const experimentId=previous?.status==='cancelled'?previous.id:await ensureEvalExperiment({user:task.user,name:`用例分析(trace) · ${task.id}`,agentName:skillName,evaluatorIds:evaluatorIds(config),existingId:config.evalExperimentId,scope:'skill-case-analysis',skillName,skillVersion});
 config.evalExperimentId=experimentId;config.coreTraceBindings={...config.coreTraceBindings};
 for(const {id,evidence} of sources){
  const bound=previous?.cases.find(row=>row.id===config.coreTraceBindings?.[id]&&row.taskId===evidence.execution.taskId&&!row.deletedAt);
  const input={taskId:evidence.execution.taskId,executionId:evidence.execution.id,input:evidence.execution.query||'',actualOutput:evidence.execution.finalResult||'',referenceOutput:null};
  config.coreTraceBindings[id]=previous?.status==='cancelled'?(bound?.id||await addEvalExperimentCase(experimentId,input,{allowCancelled:true})):await addEvalExperimentCase(experimentId,input);
  states[id]={status:'pending',sessionId:evidence.execution.taskId};
 }
 const caseIds=ids.map(id=>config.coreTraceBindings![id]);
 const operationKey=same&&(prior!.phase==='prepared'||anyActive||prior!.key===context.operationKey)?prior!.key:context.operationKey;
 config.coreTraceOperation={key:operationKey,caseIds,action,phase:'prepared'};
 const preparedConfig=JSON.stringify(config);
 const bound=await prisma.batchEvalTask.updateMany({where:{id:task.id,user:task.user,configJson:task.configJson,caseStatesJson:task.caseStatesJson},data:{configJson:preparedConfig,caseStatesJson:JSON.stringify(states)}});
 if(bound.count!==1)throw failure('Batch configuration changed before start',409);
 const saved=context.operationKey;context.operationKey=operationKey;
 try{
  const concurrency=Math.max(1,Number(config.agentMaxConcurrency||4));
  const operation=coreExperimentStartOperation(context,experimentId,{caseIds});
  const receipt=await lookupCoreExperimentOperation(context,'start',operation.key,operation.request);
  if(receipt){
   if((receipt.experiment as {id?:unknown}|undefined)?.id!==experimentId)throw failure('Batch start receipt differs',503);
   void activateExperimentWork(context,experimentId,{concurrency}).catch(error=>console.error('[CORE_BATCH_TRACE_WORK]',error));
  }else{
   const started=await startEvalExperimentCases(experimentId,caseIds,task.user,{concurrency});
   if(!started)throw failure('Durable Batch work unavailable',503);
   void started.completion.catch(error=>console.error('[CORE_BATCH_TRACE_WORK]',error));
  }
 }finally{context.operationKey=saved;}
 config.coreTraceOperation.phase='submitted';
 const submitted=await prisma.batchEvalTask.updateMany({where:{id:task.id,user:task.user,configJson:preparedConfig},data:{configJson:JSON.stringify(config)}});
 if(submitted.count!==1)throw failure('Batch work is durable but control acknowledgement changed',409);
}
export async function abortCoreBatchTrace(task:Batch){
 requireOwner(task.user);await assertCoreBatchScope('abort');const context=requireCoreExperimentContext();const config:Config=JSON.parse(task.configJson||'{}');
 if(!config.evalExperimentId)return {ok:true,abortedAt:Date.now(),hadActiveRun:false,reset:0};
 const experiment=await ownedExperiment(config.evalExperimentId);
 const active=experiment.cases.filter(row=>row.results?.some(value=>['pending','running'].includes(value.status))).length;
 await cancelCoreExperimentExecution(context,config.evalExperimentId);
 return {ok:true,abortedAt:Date.now(),hadActiveRun:active>0,reset:active};
}
export function preserveCoreBatchBindings(previous:Record<string,unknown>,incoming:Record<string,unknown>){
 const datasetIntent=previous.coreDatasetOperation as {phase?:string;cancelRequested?:boolean}|undefined;if(datasetIntent?.phase==='prepared'&&!datasetIntent.cancelRequested)throw failure('Batch preparation is already running',409);
 const next={...incoming};for(const key of ['coreTraceBindings','coreTraceOperation','coreDatasetBindings','coreDatasetOperation','coreDatasetContext','evalExperimentId'])delete next[key];
 if(previous.evalExperimentId){
  for(const key of previous.sourceMode==='trace'?['sourceMode','skillId','versionId','evalExperimentId']:['evalExperimentId'])if(incoming[key]!==undefined&&incoming[key]!==previous[key])throw failure('Bound Batch context cannot be replaced',409);
  for(const key of previous.sourceMode==='trace'?['sourceMode','skillId','versionId','evalExperimentId']:['evalExperimentId'])if(previous[key]!==undefined)next[key]=previous[key];
 }
 if(previous.coreTraceBindings)next.coreTraceBindings=previous.coreTraceBindings;
 if(previous.coreTraceOperation)next.coreTraceOperation=previous.coreTraceOperation;
 for(const key of ['coreDatasetBindings','coreDatasetOperation','coreDatasetContext'])if(previous[key])next[key]=previous[key];
 return next;
}
