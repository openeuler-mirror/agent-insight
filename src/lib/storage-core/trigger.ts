import {createHash} from 'node:crypto';
import {withCoreExperiments,requireCoreExperimentContext,getCoreExperimentContext,lookupCoreExperimentOperation,type CoreExperimentContext} from './experiments';
import type {SkillTriggerEvalRunRecord} from '@/server/skill_trigger_eval_storage';

type Row=Record<string,unknown>;
export type TriggerOperation='read'|'save'|'delete'|'upload'|'run'|'draft'|'cancel';
export interface FrozenTriggerManifest extends Row {
 version:1;kind:'run'|'draft';legacy_owner:string;skill:{id:string;name:string;version:number;content:string};
 trigger_set:{id:string;version:number;items:Array<{id:string;query:string;shouldTrigger:boolean;source:string}>};
 siblings:Array<{name:string;version:number;content:string}>;history:Row[];
 params:{runsPerQuery:number;triggerThreshold:number;timeoutMs:number;concurrency:number;maxTimeoutRetries:number};
 model_selection:Row|null;modelId:string|null;modelConfigId?:string;workspaceRoot:string|null;
}
const fail=(message:string,status:number)=>Object.assign(new Error(message),{status});
export function coreTriggerFailure(error:unknown):Response{
 const status=(error as {status?:number})?.status;
 return Response.json({error:status===401?'请重新登录后操作':status===403?'无权访问触发评测':error instanceof Error?error.message:'触发评测请求失败',...(status===409&&(error as {run?:SkillTriggerEvalRunRecord})?.run?{run:(error as {run:SkillTriggerEvalRunRecord}).run}:{}),...(status===409&&(error as {set?:unknown})?.set?{set:(error as {set:unknown}).set}:{})},{status:typeof status==='number'&&[400,401,403,404,409,410,413,422,429,503].includes(status)?status:502,headers:{'cache-control':'no-store',...(status===409&&(error as {code?:string})?.code==='TRIGGER_READ_CHANGED'?{'x-storage-retry':'trigger-read-changed'}:{})}});
}
export async function withCoreTriggerRoute(request:Request,operation:TriggerOperation,handler:(request:Request)=>Promise<Response>):Promise<Response>{
 try{return await withCoreExperiments(request,async()=>{
  const context=requireCoreExperimentContext();const scope=await context.rpc('trigger_scope',{operation}) as Row;
  if(scope.authorized!==true||scope.operation!==operation||scope.principal_id!==context.actor.principal||scope.workspace_id!==context.actor.workspace)throw fail('Trusted Trigger capability scope unavailable',403);
  const url=new URL(request.url);url.searchParams.set('user',context.actor.username);const headers=new Headers(request.headers);headers.delete('content-length');
  const normalized=new Request(url,{method:request.method,headers,...(['POST','PUT','PATCH'].includes(request.method)?{body:JSON.stringify({...context.body,user:context.actor.username})}:{})});
  const previous=context.triggerRoute;context.triggerRoute=true;
  try{return await handler(normalized);}finally{context.triggerRoute=previous;}
 });}catch(error){return coreTriggerFailure(error);}
}
export async function readCoreTriggerRuns(skillName:string,options:{skillVersion?:number;limit?:number;latestOnly?:boolean;runningOnly?:boolean}={}):Promise<{runs?:SkillTriggerEvalRunRecord[];run?:SkillTriggerEvalRunRecord|null}>{
 const context=requireCoreExperimentContext();const result=await context.rpc('trigger_list',{skill_name:skillName,...(options.skillVersion!==undefined?{skill_version:options.skillVersion}:{}),limit:options.limit??50,latest_only:options.latestOnly===true,running_only:options.runningOnly===true}) as {runs?:SkillTriggerEvalRunRecord[];run?:SkillTriggerEvalRunRecord|null};
 if(!result||(options.latestOnly?!Object.hasOwn(result,'run'):!Array.isArray(result.runs)))throw fail('Trigger history coverage unavailable',503);
 const owner=(row:SkillTriggerEvalRunRecord)=>row;
 return options.latestOnly?{run:result.run?owner(result.run):null}:{runs:(result.runs||[]).map(owner)};
}
export async function readCoreTriggerRun(id:string):Promise<{run:SkillTriggerEvalRunRecord;operation_hash:string;[key:string]:unknown}>{
 const context=requireCoreExperimentContext();const result=await context.rpc('trigger_read',{run_id:id}) as {run:SkillTriggerEvalRunRecord;operation_hash:string};
 if(!result?.run||result.run.id!==id)throw fail('Trigger Run unavailable',503);
 if(typeof result.operation_hash!=='string'||!/^[a-f0-9]{64}$/.test(result.operation_hash))throw fail('Trigger operation provenance unavailable',503);
 return result;
}
export async function freezeCoreTriggerRun(context:CoreExperimentContext,skillName:string,body:Row):Promise<FrozenTriggerManifest>{
 const {findTriggerEvalSetById,findLatestTriggerEvalSet}=await import('@/server/skill_trigger_eval_storage');
 const set=body.triggerSetId?await findTriggerEvalSetById(String(body.triggerSetId).trim()):await findLatestTriggerEvalSet(context.actor.username,skillName);
 if(!set||set.user!==context.actor.username||set.skillName!==skillName)throw fail('trigger eval set not configured',404);
 if(!set.items.length)throw fail('trigger eval set has no items',400);
 const {prismaRaw}=await import('@/lib/storage/prisma');
 const skills=await prismaRaw.skill.findMany({where:{user:context.actor.username},include:{versions:{orderBy:{version:'desc',},take:1}}});
 const skill=skills.find(value=>value.name===skillName);if(!skill?.versions.length)throw fail('skill not found or has no versions',404);
 if(body.skillVersion!==undefined&&body.skillVersion!==null&&!Number.isSafeInteger(Number(body.skillVersion)))throw fail('requested skillVersion not found',404);
 const version=body.skillVersion===undefined||body.skillVersion===null?skill.versions[0]:skill.versions.find(value=>value.version===Number(body.skillVersion))||await prismaRaw.skillVersion.findFirst({where:{skillId:skill.id,version:Number(body.skillVersion)}});
 if(!version)throw fail('requested skillVersion not found',404);
 const active=(await readCoreTriggerRuns(skillName,{skillVersion:version.version,runningOnly:true,limit:1})).runs?.[0];
 if(active)throw Object.assign(fail('该版本已有一次评测正在运行，等它结束再发起',409),{run:active});
 const {resolveTriggerModelConfiguration}=await import('@/lib/engine/skill-generation/evaluator/runners/triggerEval');
 const modelConfigId=body.modelConfigId?String(body.modelConfigId).trim():undefined;
 const model=await resolveTriggerModelConfiguration(context.actor.username,modelConfigId);
 const {freezeModelSelection}=await import('./frozen-model');
 const {resolveMaxTimeoutRetries}=await import('@/lib/engine/skill-generation/evaluator/runners/triggerEvalRetry');
 const params={runsPerQuery:Math.max(1,Math.min(10,Number(body.runsPerQuery??1))),triggerThreshold:Math.max(0,Math.min(1,Number(body.triggerThreshold??0.5))),timeoutMs:Math.max(5000,Math.min(300000,Number(body.timeoutMs??60000))),concurrency:Math.max(1,Math.min(10,Number(body.concurrency??5))),maxTimeoutRetries:resolveMaxTimeoutRetries(process.env.TRIGGER_EVAL_TIMEOUT_RETRIES)};
 if(!Object.values(params).every(Number.isFinite)||!['runsPerQuery','timeoutMs','concurrency'].every(key=>Number.isSafeInteger(params[key as keyof typeof params])))throw fail('Invalid Trigger parameters',400);
 const {ensureSessionWorkspace}=await import('@/lib/engine/general-agent/workspace');
 const workspaceRoot=ensureSessionWorkspace(context.actor.username,'trigger-core-'+createHash('sha256').update(context.operationKey).digest('hex'));
 const old=(await readCoreTriggerRuns(skillName,{limit:50})).runs||[];const scores=new Map<number,number>();
 for(const run of old)if(run.status==='done'&&run.skillVersion!==version.version&&!scores.has(run.skillVersion))scores.set(run.skillVersion,run.passRate);
 const history:Row[]=scores.size?(await prismaRaw.skillVersion.findMany({where:{skillId:skill.id,version:{in:[...scores.keys()]}}})).map(value=>({version:value.version,content:value.content,passRate:scores.get(value.version)!})).sort((left,right)=>left.version-right.version):[];
 return {version:1,kind:'run',legacy_owner:context.actor.username,skill:{id:skill.id,name:skill.name,version:version.version,content:version.content},trigger_set:{id:set.id,version:set.version,items:set.items},siblings:skills.filter(value=>value.name!==skillName&&value.versions.length).map(value=>({name:value.name,version:value.versions[0].version,content:value.versions[0].content})),history,params,model_selection:freezeModelSelection(model),modelId:modelConfigId??null,...(modelConfigId?{modelConfigId}:{}),workspaceRoot};
}
export async function startCoreTriggerRun(skillName:string,body:Row):Promise<Response>{
 const context=requireCoreExperimentContext();let started=await lookupCoreExperimentOperation(context,'trigger_begin') as {run:SkillTriggerEvalRunRecord;experiment_id:string}|null;
 if(!started){const manifest=await freezeCoreTriggerRun(context,skillName,body);const skill=manifest.skill;try{started=await context.rpc('trigger_begin',{manifest,releases:{},config:{derived_skill_ids:[skill.id],derived_skill_versions:{[skill.id]:[skill.version]}}}) as {run:SkillTriggerEvalRunRecord;experiment_id:string};}catch(error){if((error as {status?:number}).status===409){const active=(await readCoreTriggerRuns(skillName,{skillVersion:skill.version,runningOnly:true,limit:1})).runs?.[0];if(active)throw Object.assign(fail('该版本已有一次评测正在运行，等它结束再发起',409),{run:active});}throw error;}}
 if(!started?.run||started.run.id!==started.experiment_id)throw fail('Durable Trigger Run unavailable',503);
 const {activateExperimentWork}=await import('./experiment-worker');void activateExperimentWork(context,started.experiment_id,{concurrency:1}).catch(error=>console.error('[CORE_TRIGGER_RUN]',error));
 return Response.json({success:true,run:started.run});
}
export async function cancelCoreTriggerRun(skillName:string,id:string):Promise<Response>{
 const context=requireCoreExperimentContext();const previous=await readCoreTriggerRun(id);
 if(previous.run.skillName!==skillName)throw fail('run does not belong to this skill',404);
 let value=await context.rpc('trigger_cancel',{run_id:id}) as {run:SkillTriggerEvalRunRecord;operation_hash:string;cancellation_id:string|null;targets:Array<Row>};
 if(value?.run?.id!==id||value.run.skillName!==skillName||!Array.isArray(value.targets)||typeof value.operation_hash!=='string'||!/^[a-f0-9]{64}$/.test(value.operation_hash))throw fail('Trigger cancellation provenance unavailable',503);
 const targets=value.targets.filter(target=>target.confirmed!==true);const {stopCoreEvaluationAttempt}=await import('./experiment-worker');
 for(const target of targets){const proof=await stopCoreEvaluationAttempt(context,target as unknown as import('./experiment-worker').CoreEvaluationTarget);value=await context.rpc('trigger_cleanup',{run_id:id,cancellation_id:value.cancellation_id,proof}) as typeof value;}
 return Response.json({success:true,aborted:targets.length>0,run:value.run},{headers:{'x-storage-trigger-operation':value.operation_hash}});
}
export async function startCoreTriggerDraft(skillName:string,body:Row):Promise<Response>{const {startDraft}=await import('./trigger-draft');return startDraft(skillName,body);}
export const isCoreTriggerRoute=()=>getCoreExperimentContext()?.triggerRoute===true;
