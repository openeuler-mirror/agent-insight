import {createHash,timingSafeEqual} from 'node:crypto';
import {readControllerKey,signControllerPayload} from './controller';
import type {Experiment,GrayscaleTask} from '@prisma/client';
import {prismaRaw} from '@/lib/storage/prisma';
import {requireCoreExperimentContext} from './experiments';
import {freezeExperimentAssets} from './experiment-assets';
type Row=Record<string,unknown>;
interface Intent {version:1;phase:'prepared'|'ready';workspace:string;principal:string;requestHash:string;experimentId:string;operationKey:string;experiment:Row;taskConfig:Row;proof:string}
export interface WorkbenchHandoffInput {experiment:Row;task:Row;taskConfig:Row;snapshot:Row;frozen?:boolean}
export interface WorkbenchHandoffResult {experiment:Experiment;grayscaleTask:GrayscaleTask;configSnapshot:Row}
function digest(value:unknown){const stable=(entry:unknown):unknown=>Array.isArray(entry)?entry.map(stable):entry&&typeof entry==='object'?Object.fromEntries(Object.entries(entry).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)])):entry;return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');}
function scope(user:string){const context=requireCoreExperimentContext();if(user!==context.actor.username)throw Object.assign(new Error('Workbench actor differs'),{status:403});return context;}
function identity(user:string){const context=scope(user);const hash=digest([context.actor.workspace,context.actor.principal,new URL(context.request.url).pathname,context.operationKey]);return {context,taskId:'workbench-task-'+hash.slice(0,40),experimentId:'workbench-exp-'+hash.slice(0,40),requestHash:digest({path:new URL(context.request.url).pathname,body:context.body})};}
function parse(value:string):Row{const parsed=JSON.parse(value);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Object.assign(new Error('Workbench handoff data unavailable'),{status:503});return parsed;}
function proofBody(intent:Intent){return JSON.stringify({version:intent.version,workspace:intent.workspace,principal:intent.principal,requestHash:intent.requestHash,experimentId:intent.experimentId,operationKey:intent.operationKey,experiment:intent.experiment,taskConfig:intent.taskConfig});}
async function proof(intent:Intent){return signControllerPayload(await readControllerKey(),'workbench-handoff/v1',intent.principal,intent.workspace,proofBody(intent));}
export async function readCoreWorkbenchTaskConfiguration(user:string,task:Pick<GrayscaleTask,'id'|'configJson'>):Promise<Row>{
 const context=scope(user);const configuration=parse(task.configJson);const intent=configuration.__storageCoreHandoff as Intent|undefined;
 if(!intent)return configuration;
 if(intent.version!==1||intent.workspace!==context.actor.workspace||intent.principal!==context.actor.principal||configuration.evalExperimentId!==intent.experimentId)throw Object.assign(new Error('Workbench Task handoff binding differs'),{status:403});
 const expected=await proof(intent);if(!/^[a-f0-9]{64}$/.test(intent.proof)||!timingSafeEqual(Buffer.from(intent.proof,'hex'),Buffer.from(expected,'hex')))throw Object.assign(new Error('Workbench handoff proof differs'),{status:403});
 if(intent.phase!=='ready'){const recovered=await recoverCoreWorkbenchHandoff(user,task.id);if(!recovered)throw Object.assign(new Error('Workbench handoff is pending'),{status:503});}
 const frozenConfig=parse(String(intent.experiment.configSnapshotJson||'{}'));if(frozenConfig.grayscaleTaskId!==task.id)throw Object.assign(new Error('Workbench Task identity differs'),{status:403});
 return {...intent.taskConfig,__storageCoreHandoff:intent,...(configuration.latestResultAt?{latestResultAt:configuration.latestResultAt}:{})};
}
async function finish(user:string,task:GrayscaleTask,recover=false):Promise<WorkbenchHandoffResult>{
 const {context,experimentId,requestHash}=identity(user);const configuration=parse(task.configJson);const intent=configuration.__storageCoreHandoff as Intent|undefined;
 if(!intent||intent.version!==1||intent.workspace!==context.actor.workspace||intent.principal!==context.actor.principal)throw Object.assign(new Error('Workbench handoff owner differs'),{status:403});
 const expectedProof=await proof(intent);if(!/^[a-f0-9]{64}$/.test(intent.proof)||!timingSafeEqual(Buffer.from(intent.proof,'hex'),Buffer.from(expectedProof,'hex')))throw Object.assign(new Error('Workbench handoff proof differs'),{status:403});
 if(!recover&&(intent.requestHash!==requestHash||intent.experimentId!==experimentId))throw Object.assign(new Error('Workbench creation request changed'),{status:409});
 const receipt=await context.rpc('create',{experiment:intent.experiment,operation_key:intent.operationKey,operation_request:{kind:'workbench-handoff/v1',request_hash:intent.requestHash,experiment_id:intent.experimentId,task_id:task.id}}) as {experiment:Experiment};
 if(receipt?.experiment?.id!==intent.experimentId)throw Object.assign(new Error('Workbench creation receipt differs'),{status:503});
 let current=task;
 if(intent.phase!=='ready'){
  const {__storageCoreHandoff:_marker,...actualConfig}=configuration;if(digest(actualConfig)!==digest(intent.taskConfig))throw Object.assign(new Error('Workbench prepared task configuration changed'),{status:409});
  const ready=JSON.stringify({...configuration,__storageCoreHandoff:{...intent,phase:'ready'}});
  const changed=await prismaRaw.grayscaleTask.updateMany({where:{id:task.id,user,configJson:task.configJson},data:{configJson:ready}});
  if(!changed.count){const latest=await prismaRaw.grayscaleTask.findFirst({where:{id:task.id,user}});const snapshot=latest?parse(latest.configJson):null;const marker=snapshot?.__storageCoreHandoff as Intent|undefined;if(!latest||marker?.phase!=='ready'||marker.requestHash!==intent.requestHash||marker.experimentId!==intent.experimentId)throw Object.assign(new Error('Workbench handoff changed after core creation'),{status:409});current=latest;}
  else current={...task,configJson:ready};
 }
 return {experiment:receipt.experiment,grayscaleTask:current,configSnapshot:parse(receipt.experiment.configSnapshotJson||'{}')};
}
export async function resumeCoreWorkbenchHandoff(user:string):Promise<WorkbenchHandoffResult|null>{const {taskId}=identity(user);const task=await prismaRaw.grayscaleTask.findFirst({where:{id:taskId,user}});return task?finish(user,task):null;}
export async function recoverCoreWorkbenchHandoff(user:string,taskId:string):Promise<WorkbenchHandoffResult|null>{scope(user);const task=await prismaRaw.grayscaleTask.findFirst({where:{id:taskId,user}});return task?finish(user,task,true):null;}
export async function createCoreWorkbenchHandoff(user:string,input:WorkbenchHandoffInput):Promise<WorkbenchHandoffResult>{
 const existing=await resumeCoreWorkbenchHandoff(user);if(existing)return existing;
 const {context,taskId,experimentId,requestHash}=identity(user);
 const configuration={...input.snapshot,grayscaleTaskId:taskId};const data={...input.experiment,id:experimentId,user,configSnapshotJson:JSON.stringify(configuration)};
 const prepared=input.frozen?data:await freezeExperimentAssets(context,data);
 const configurationForTask={...input.taskConfig,evalExperimentId:experimentId,evaluationBatchTitle:String(input.experiment.name)};
 const intent:Intent={version:1,phase:'prepared',workspace:context.actor.workspace,principal:context.actor.principal,requestHash,experimentId,operationKey:context.operationKey+':workbench-create',experiment:prepared,taskConfig:configurationForTask,proof:''};intent.proof=await proof(intent);
 const taskConfig=JSON.stringify({...configurationForTask,__storageCoreHandoff:intent});
 if(Buffer.byteLength(taskConfig,'utf8')>64*1024*1024)throw Object.assign(new Error('Workbench handoff exceeds byte budget'),{status:413});
 let task:GrayscaleTask;
 try{task=await prismaRaw.grayscaleTask.create({data:{...input.task,id:taskId,user,taskName:String(input.task.taskName||input.experiment.name)+' · '+experimentId.slice(-6),configJson:taskConfig} as Parameters<typeof prismaRaw.grayscaleTask.create>[0]['data']});}
 catch(error){if((error as {code?:string}).code!=='P2002')throw error;const resumed=await resumeCoreWorkbenchHandoff(user);if(!resumed)throw error;return resumed;}
 return finish(user,task);
}
