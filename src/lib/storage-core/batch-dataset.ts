import {createHash} from 'node:crypto';
import {prisma} from '@/lib/storage/prisma';
import {requireCoreExperimentContext,lookupCoreExperimentOperation,runWithCoreExperimentContext,type CoreExperimentContext} from './experiments';
import {assertCoreBatchScope} from './batch-trace';
import {ensureEvalExperiment} from '@/lib/engine/experiment/run-experiment';
import {freezeExperimentAssets,prepareCoreExperimentStart} from './experiment-assets';
import {consumeCoreLocalExecution,recoverCoreLocalExecution} from './workbench-local-execution';
import {runGeneralAgent} from '@/lib/engine/general-agent';
import {withBackgroundOpencodeSlot} from '@/lib/engine/general-agent/concurrency-limiter';
import {activateExperimentWork} from './experiment-worker';
import {cancelCoreExperimentExecution} from './experiment-cancellation';

type Row=Record<string,unknown>;
interface Batch {id:string;user:string;configJson:string;caseStatesJson:string;traceEvalStatesJson?:string}
interface Intent {key:string;action:string;ids:string[];caseIds:string[];phase:'prepared'|'submitted';request:Row;payload:Row;cancelRequested?:boolean}
interface Config extends Row {datasetIds?:string[];skillId?:string;versionId?:string;autoEval?:boolean;agentMaxConcurrency?:number;evaluators?:string[];evaluatorId?:string;evaluationBatchId?:string;evaluationBatchEvaluators?:string[];evalExperimentId?:string;coreDatasetBindings?:Record<string,string>;coreDatasetContext?:{skillId?:string;versionId?:string};coreDatasetOperation?:Intent}
interface Case extends Row {id:string;input:string;taskId?:string;coreExecution?:{runId:string;status:string;attemptId?:string|null;stage?:string;evaluateAfterExecution?:boolean;evaluatorIds?:string[];input?:string;skillName?:string;skillVersion?:number|null;runtimeStartedAtMs?:number;runtimeFinishedAtMs?:number;createdAt?:string;finishedAt?:string;error?:string};results?:Array<{evaluatorId:string;status:string;score?:number|null;coreResult?:unknown;coreWork?:{finishedAt?:string};errorMessage?:string}>}
interface Experiment extends Row {id:string;status:string;skillName?:string;skillVersion?:number|null;configSnapshotJson?:string;evaluatorIdsJson?:string;cases:Case[]}
const fail=(message:string,status:number)=>Object.assign(new Error(message),{status});
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const owned=(user:string)=>{if(user!==requireCoreExperimentContext().actor.username)throw fail('Batch actor differs',403);};
async function read(context:CoreExperimentContext,id:string):Promise<{experiment:Experiment;revision:string}>{
 const found=await context.rpc('read',{experiment_id:id}) as {experiment?:Experiment;revision:string;gold_redacted?:boolean};
 if(found.gold_redacted)throw fail('Batch Experiment belongs to another actor',403);if(!found.experiment)throw fail('Batch Experiment unavailable',404);return {experiment:found.experiment,revision:found.revision};
}
const active=(row:Case)=>['queued','running'].includes(row.coreExecution?.status||'')||row.results?.some(value=>value.coreWork&&['pending','running'].includes(value.status));
const evaluators=(config:Config)=>config.evaluationBatchId&&config.evaluationBatchEvaluators?.length?config.evaluationBatchEvaluators:config.evaluators?.length?config.evaluators:config.evaluatorId?[config.evaluatorId]:['preset-agent-task-completion'];
const sourceCases=(experiment:Experiment)=>{
 const snapshot=JSON.parse(experiment.configSnapshotJson||'{}') as {coreBatchDatasets?:{datasets?:Array<{id:string;cases:Array<{id:string;input?:string;expectedOutput?:string|null}>}>}};
 const result=new Map<string,{datasetId:string;id:string;input:string;referenceOutput:string|null}>();
 for(const dataset of snapshot.coreBatchDatasets?.datasets||[])for(const row of dataset.cases){if(result.has(row.id))throw fail('Dataset Case identity is ambiguous',409);result.set(row.id,{datasetId:dataset.id,id:row.id,input:row.input||'',referenceOutput:row.expectedOutput??null});}
 return result;
};
async function save(task:Batch,config:Config,states?:Row){
 const next=JSON.stringify(config);const data={configJson:next,...(states?{caseStatesJson:JSON.stringify(states)}:{})};
 const changed=await prisma.batchEvalTask.updateMany({where:{id:task.id,user:task.user,configJson:task.configJson,caseStatesJson:task.caseStatesJson},data});
 if(changed.count!==1)throw fail('Batch configuration changed',409);Object.assign(task,data);
}
const activations=new Map<string,Promise<void>>();
function activate(context:CoreExperimentContext,experimentId:string,intent:Intent,concurrency:number):Promise<void>{
 const key=JSON.stringify([context.actor.workspace,context.actor.principal,experimentId,intent.key]);const prior=activations.get(key);if(prior)return prior;
 const work=runWithCoreExperimentContext(context,async()=>{
  const queue=[...intent.caseIds];
  await Promise.all(Array.from({length:concurrency},async()=>{
   while(queue.length){const caseId=queue.shift()!;const latest=(await read(context,experimentId)).experiment;const row=latest.cases.find(row=>row.id===caseId);
    if(!row||row.coreExecution?.runId!==String(intent.payload.run_id))continue;
    if(row.coreExecution.status==='running'&&row.coreExecution.attemptId){
     try{await recoverCoreLocalExecution(context,{user:context.actor.username,experimentId,caseId,runId:row.coreExecution.runId,attemptId:row.coreExecution.attemptId});if(row.coreExecution.evaluateAfterExecution!==false)await activateExperimentWork(context,experimentId,{concurrency});}catch{}
     continue;
    }
    if(row.coreExecution.status!=='queued')continue;
    try{
     await consumeCoreLocalExecution(context,{user:context.actor.username,experimentId,caseId,runId:row.coreExecution.runId,signal:new AbortController().signal},(signal,work)=>{const publicIds=work.execution_request.batch_case_ids as Record<string,string>|undefined;const datasetCaseId=publicIds?.[caseId]||caseId;return withBackgroundOpencodeSlot(()=>runGeneralAgent({
      user:context.actor.username,query:String(work.raw_case.input||''),skill:typeof work.experiment_config.skillName==='string'&&work.experiment_config.skillName?work.experiment_config.skillName:undefined,
      skillVersion:typeof work.experiment_config.skillVersion==='number'?work.experiment_config.skillVersion:undefined,interactionPolicy:'auto-deny',systemAgentName:'skill-debug-executor',ephemeralServer:true,recordTraceAs:'skill-debug-executor',sessionTitle:`batch ${context.actor.username} · ${String(intent.request.task_id)} · ${datasetCaseId.slice(0,8)}`,workspaceTag:`batch-${String(intent.request.task_id)}-${datasetCaseId}`,tagSkill:typeof work.experiment_config.skillName==='string'?work.experiment_config.skillName:undefined,
     }),{taskType:'batch-eval',user:context.actor.username,label:`batch-${datasetCaseId.slice(0,8)}`,skill:typeof work.experiment_config.skillName==='string'?work.experiment_config.skillName:undefined,skillVersion:typeof work.experiment_config.skillVersion==='number'?work.experiment_config.skillVersion:null,signal});});
     if(row.coreExecution.evaluateAfterExecution!==false)await activateExperimentWork(context,experimentId,{concurrency});
    }catch(error){if(![401,403,409,410,503].includes((error as {status?:number}).status||0))console.error('[CORE_BATCH_DATASET_CASE]',error);}
   }
  }));
 });activations.set(key,work);void work.finally(()=>{if(activations.get(key)===work)activations.delete(key);}).catch(()=>{});return work;
}
export async function startCoreBatchDataset(task:Batch,selected:string[],action:'start'|'retry-execute'|'retry-evaluate'):Promise<void>{
 owned(task.user);await assertCoreBatchScope(action);const context=requireCoreExperimentContext();let config:Config=JSON.parse(task.configJson||'{}');
 const ids=[...new Set(selected.map(String).map(value=>value.trim()).filter(Boolean))];if(!ids.length||action!=='start'&&ids.length!==1)throw fail('Batch Case selection required',400);
 const concurrency=Math.max(1,Number(config.agentMaxConcurrency||4));if(!Number.isSafeInteger(concurrency)||concurrency>1024)throw fail('Invalid Batch concurrency',400);
 const previous=config.coreDatasetOperation;if(previous?.cancelRequested&&previous.key===context.operationKey)throw fail('Batch operation was cancelled',409);
 const continuing=previous&&!previous.cancelRequested&&previous.action===action&&same(previous.ids,ids)&&(previous.phase==='prepared'||previous.key===context.operationKey);
 if(previous?.phase==='prepared'&&!previous.cancelRequested&&!continuing)throw fail('Batch preparation is already running',409);
 const operationKey=continuing?previous.key:context.operationKey;const operation=operationKey+':batch-dataset:'+action;
 const request={task_id:task.id,action,case_ids:ids};const kind=action==='retry-evaluate'?'start':'execute_start';
 const receipt=await lookupCoreExperimentOperation(context,kind,operation,request);
 if(receipt){
  const experiment=(receipt.experiment as Experiment|undefined);if(!experiment||config.evalExperimentId&&config.evalExperimentId!==experiment.id)throw fail('Batch receipt binding differs',409);
  await read(context,experiment.id);const intent=config.coreDatasetOperation;
  if(!intent||intent.key!==operationKey||!same(intent.request,request))throw fail('Batch receipt requires its prepared binding',409);
  intent.phase='submitted';intent.payload={...intent.payload,run_id:receipt.run_id};await save(task,config);
  if(action==='retry-evaluate')void activateExperimentWork(context,experiment.id,{concurrency}).catch(error=>console.error('[CORE_BATCH_DATASET_EVAL]',error));else void activate(context,experiment.id,intent,concurrency).catch(error=>console.error('[CORE_BATCH_DATASET_WORK]',error));return;
 }
 let found=config.evalExperimentId?await read(context,config.evalExperimentId):undefined;
 if(found?.experiment.cases.some(row=>(action==='start'||ids.some(id=>config.coreDatasetBindings?.[id]===row.id))&&active(row))&&!continuing)throw fail('task is already running',409);
 if(continuing&&typeof previous.payload.experiment_id==='string'){
  if(!found)throw fail('Prepared Batch Experiment unavailable',409);
 }else{
  let skillName='';let skillVersion:number|null=null;
  if(action==='start'&&config.skillId){if(!config.versionId)throw fail('selected skill version is required',400);const skill=await prisma.skill.findFirst({where:{id:config.skillId,user:task.user},select:{name:true}});const version=await prisma.skillVersion.findFirst({where:{id:config.versionId,skillId:config.skillId},select:{version:true}});if(!skill||!version)throw fail('selected skill version not found',404);skillName=skill.name;skillVersion=version.version;}
  if(action==='start'&&config.evaluationBatchId){const linked=(await read(context,config.evaluationBatchId)).experiment;if((linked.skillName||'')!==skillName||(linked.skillVersion??null)!==skillVersion)throw fail('evaluation task belongs to a different skill or version',409);}
  if(!found&&action!=='start')throw fail('retry requires an existing typed execution',409);
  const changes=action==='start'?await freezeExperimentAssets(context,{...found?.experiment,skillName,skillVersion,agentName:skillName,evaluatorIdsJson:JSON.stringify(evaluators(config)),configSnapshotJson:JSON.stringify({datasetIds:config.datasetIds})}):undefined;
  const cut=changes?sourceCases(changes as Experiment):undefined;if(cut)for(const id of ids)if(!cut.has(id))throw fail('Selected Case not found in frozen Dataset cut',404);
  const priorConfig=task.configJson;let reservation:Batch|undefined;let caseWritesCommitted=false;
  if(!continuing){config.coreDatasetOperation={key:operationKey,action,ids,caseIds:[],phase:'prepared',request,payload:{}};await save(task,config);reservation={...task};}
  try{
  if(!found){const id=await ensureEvalExperiment({user:task.user,name:`用例分析(dataset) · ${task.id}`,agentName:skillName,evaluatorIds:evaluators(config),scope:'skill-case-analysis',skillName,skillVersion,datasetIds:config.datasetIds});found=await read(context,id);config.evalExperimentId=id;}
  if(action==='start'){
   const payload={experiment_id:found.experiment.id,expected_revision:found.revision,changes:Object.fromEntries(['skillName','skillVersion','agentName','evaluatorIdsJson','configSnapshotJson'].map(key=>[key,changes![key]]))};
   await context.rpc('update',{...payload,operation_key:operationKey+':batch-dataset-definition',operation_request:request});found=await read(context,found.experiment.id);
  }
  const experiment=found.experiment;config.evalExperimentId=experiment.id;const bindings={...config.coreDatasetBindings};const states:Row={...JSON.parse(task.caseStatesJson||'{}')};let caseIds:string[];
  if(action==='start'){
   const records:Row[]=[];caseIds=[];
   for(const id of ids){const source=cut!.get(id)!;const caseId=bindings[id]||'batch-local-'+createHash('sha256').update(JSON.stringify([context.actor.workspace,context.actor.principal,task.id,source.datasetId,id])).digest('hex').slice(0,40);
    records.push({id:caseId,input:source.input,datasetInput:source.input,referenceOutput:source.referenceOutput,actualOutput:'',taskId:null,executionId:null,caseValuesJson:JSON.stringify({__agentInsightDatasetCase:{datasetId:source.datasetId,caseId:id}})});bindings[id]=caseId;caseIds.push(caseId);states[id]={status:'pending',input:source.input};
   }
   const payload={experiment_id:experiment.id,expected_revision:found.revision,cases:records};const saved=await context.rpc('case_upsert_many',{...payload,operation_key:operationKey+':batch-dataset-cases',operation_request:payload}) as {case_ids:string[]};caseWritesCommitted=true;if(!same(saved.case_ids,caseIds))throw fail('Batch Case binding differs',503);
  }else{const row=experiment.cases.find(row=>row.id===bindings[ids[0]]);if(!row?.coreExecution)throw fail('retry requires an existing typed execution',409);if(action==='retry-evaluate'&&(row.coreExecution.status!=='done'||!row.taskId))throw fail('retry-evaluate requires a completed execution Trace',409);caseIds=[row.id];}
  const current=(await read(context,experiment.id)).experiment;let payload:Row;
  if(action==='start'){const prepared=await prepareCoreExperimentStart(context,experiment.id,{caseIds});const frozen={...prepared.payload};delete frozen.operation_key;delete frozen.operation_request;payload={...frozen,experiment_id:experiment.id,case_ids:caseIds,execution_request:{kind:'local',evaluate_after_execution:config.autoEval!==false,batch_case_ids:Object.fromEntries(ids.map((id,index)=>[caseIds[index],id]))},force_new_trace:true};}
  else{const row=current.cases.find(row=>row.id===caseIds[0])!;const source=await context.rpc('runplan',{experiment_id:experiment.id,run_id:row.coreExecution!.runId}) as {runplan:{config:Row}};payload={experiment_id:experiment.id,case_ids:caseIds,source_execution_run_id:row.coreExecution!.runId,config:source.runplan.config,...(action==='retry-execute'?{force_new_trace:true,retry_from_attempt_id:row.coreExecution!.attemptId??null}:{})};}
  config.coreDatasetBindings=bindings;if(action==='start')config.coreDatasetContext={skillId:config.skillId,versionId:config.versionId};config.coreDatasetOperation={key:operationKey,action,ids,caseIds,phase:'prepared',request,payload};await save(task,config,states);
  }catch(error){if(reservation&&!caseWritesCommitted&&[400,401,403,404,409,410,413,422].includes((error as {status?:number}).status||0)){try{await save(reservation,JSON.parse(priorConfig));Object.assign(task,reservation);}catch{}}throw error;}
 }
 config=JSON.parse(task.configJson);const intent=config.coreDatasetOperation!;
 const started=await context.rpc(kind,{...intent.payload,operation_key:operation,operation_request:intent.request}) as Row;
 if(typeof started.run_id!=='string')throw fail('Durable Dataset Batch run unavailable',503);
 intent.phase='submitted';intent.payload={...intent.payload,run_id:started.run_id};await save(task,config);
 if(action==='retry-evaluate')void activateExperimentWork(context,String(config.evalExperimentId),{concurrency}).catch(error=>console.error('[CORE_BATCH_DATASET_EVAL]',error));else void activate(context,String(config.evalExperimentId),intent,concurrency).catch(error=>console.error('[CORE_BATCH_DATASET_WORK]',error));
}
export async function projectCoreBatchDatasetTask<T extends {user:string;configJson:object;caseStatesJson:object;traceEvalStatesJson?:object}>(task:T):Promise<T|null>{
 owned(task.user);const config=task.configJson as Config;if(!config.evalExperimentId||!config.coreDatasetBindings)return task;
 if((await assertCoreBatchScope('read',config.evalExperimentId)).lifecycle==='deleted')return null;
 const experiment=(await read(requireCoreExperimentContext(),config.evalExperimentId)).experiment;const states:Row={};
 for(const id of new Set([...Object.keys(task.caseStatesJson),...Object.keys(config.coreDatasetBindings)])){
  const row=experiment.cases.find(row=>row.id===config.coreDatasetBindings![id]);const state:Row={status:'pending'};if(!row){states[id]=state;continue;}
  const execution=row.coreExecution;const contextChanged=config.coreDatasetContext&&(config.coreDatasetContext.skillId!==config.skillId||config.coreDatasetContext.versionId!==config.versionId);
  const sourceContextChanged=execution&&('skillName'in execution||'skillVersion'in execution)&&((execution.skillName||'')!==(experiment.skillName||'')||(execution.skillVersion??null)!==(experiment.skillVersion??null));
  if(contextChanged||sourceContextChanged){states[id]=state;continue;}
  state.input=execution?.input??row.input;state.evaluatorRunId=experiment.id;
  if(execution){
   if(execution.createdAt)state.startedAt=Date.parse(execution.createdAt);if(execution.runtimeStartedAtMs!==undefined)state.startedAt=execution.runtimeStartedAtMs;
   if(execution.runtimeStartedAtMs!==undefined&&execution.runtimeFinishedAtMs!==undefined)state.timeCost=((execution.runtimeFinishedAtMs-execution.runtimeStartedAtMs)/1000).toFixed(1)+'s';
   if(execution.status==='done'){state.status='executed';if(row.taskId)state.sessionId=row.taskId;}
   else if(['failed','cancelled'].includes(execution.status)){state.status='fail';state.error=execution.error||(execution.status==='cancelled'?'用户终止':'执行失败');if(execution.finishedAt)state.completedAt=Date.parse(execution.finishedAt);}
   else if(execution.status==='running')state.status='running';
  }
  const expected=execution?.evaluatorIds||JSON.parse(experiment.evaluatorIdsJson||'[]') as string[];
  const results=(row.results||[]).filter(result=>expected.includes(result.evaluatorId));const selected=results.filter(result=>result.coreResult&&['done','failed'].includes(result.status));
  if(expected.length&&selected.length===expected.length){const done=selected.filter(result=>result.status==='done'&&typeof result.score==='number'&&Number.isFinite(result.score));state.status=done.length?'pass':'fail';if(done.length)state.score=Math.round(done.reduce((sum,result)=>sum+result.score!,0)/done.length);else state.error=selected.find(result=>result.errorMessage)?.errorMessage||'评测失败';const finished=selected.map(row=>Date.parse(row.coreWork?.finishedAt||'')).filter(Number.isFinite);if(finished.length)state.completedAt=Math.max(...finished);}
  else if(results.some(result=>result.coreWork&&['pending','running'].includes(result.status)))state.status='evaluating';
  else if(results.some(result=>result.status==='cancelled')||experiment.status==='cancelled'&&state.status!=='pass'&&state.status!=='fail'){state.status='fail';state.error='用户终止';const finished=results.map(row=>Date.parse(row.coreWork?.finishedAt||'')).filter(Number.isFinite);if(finished.length)state.completedAt=Math.max(...finished);}
  states[id]=state;
 }
 const traceStates:Record<string,Row>={};for(const [id,raw] of Object.entries(task.traceEvalStatesJson||{})){const taskId=(raw as {taskId?:string}).taskId;const state=taskId?Object.values(states).find(value=>(value as Row).sessionId===taskId) as Row|undefined:undefined;traceStates[id]={status:state?.status==='pass'?'done':state?.status==='fail'?'fail':state?.status==='evaluating'?'evaluating':'idle',...(state?.sessionId?{taskId:state.sessionId}:{}),...(typeof state?.score==='number'?{score:state.score}:{})};}
 return {...task,caseStatesJson:states,...(task.traceEvalStatesJson!==undefined?{traceEvalStatesJson:traceStates}:{})};
}
export async function abortCoreBatchDataset(task:Batch){
 owned(task.user);await assertCoreBatchScope('abort');const config:Config=JSON.parse(task.configJson||'{}');if(config.coreDatasetOperation?.phase==='prepared'){config.coreDatasetOperation.cancelRequested=true;await save(task,config);}if(!config.evalExperimentId)return {ok:true,abortedAt:Date.now(),hadActiveRun:false,reset:0};const context=requireCoreExperimentContext();const experiment=(await read(context,config.evalExperimentId)).experiment;const count=experiment.cases.filter(active).length;const projected=await projectCoreBatchDatasetTask({...task,configJson:config,caseStatesJson:JSON.parse(task.caseStatesJson||'{}'),traceEvalStatesJson:task.traceEvalStatesJson===undefined?undefined:JSON.parse(task.traceEvalStatesJson||'{}')});const reset=Object.values(projected?.caseStatesJson||{}).filter(row=>['running','evaluating','executed'].includes(String((row as Row).status))).length;await cancelCoreExperimentExecution(context,experiment.id);return {ok:true,abortedAt:Date.now(),hadActiveRun:count>0,reset};
}
