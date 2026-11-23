import {runWithCoreControlActor} from './control-context';
import {matchesFrozenModelSelection} from './frozen-model';
import {runWithCoreDatasetActor} from './datasets';
import {runWithCoreEvaluatorActor} from './evaluators';
import type {PrismaClient} from '@prisma/client';
import {createExperimentReadView,type ExperimentViewSnapshot} from './experiment-view';
import {isStorageCoreEnabled} from './mode';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {compatibilityContext,isVerifiedCoreBackgroundActor,type CoreBackgroundActor,type CompatibilityOptions} from './compat';
import {readCoreBytes,requestCore} from './server';

export interface ExperimentActor {token:string;workspace:string;principal:string;username:string}
export interface CoreExperimentContext {
 triggerRoute?:boolean;
 frozenStartModelSelection?:Record<string,unknown>|null;cancelSignal?:AbortSignal;compatibilityRoute?:boolean;recordCoreTrace?:import('@/lib/engine/evaluation/evaluator-execution-recorder').CoreTraceRecorder;readView?:PrismaClient;actor:ExperimentActor;request:Request;options:CompatibilityOptions;operationKey:string;body:Record<string,unknown>;
 rpc:(action:string,payload?:Record<string,unknown>)=>Promise<unknown>;
}
const contextKey=Symbol.for('agent-insight.storage-core.experiment-context');
const globalContexts=globalThis as unknown as Record<symbol,AsyncLocalStorage<CoreExperimentContext>>;
const contexts=globalContexts[contextKey] ||= new AsyncLocalStorage<CoreExperimentContext>();
const LIMIT=64*1024*1024;
const collectionRoutes=new Set(['agents','traces','eval-runs','eval-results','eval-traces','cancellations','environment-preparations']);
const mutations=new Set(['create','update','case_upsert','case_upsert_many','case_remove','execute_start','execute_complete','execute_fail','execute_reconcile','cancellation_update','derived_issue_resolve','start','checkpoint','complete','fail','retry','cancel','review','comment','comment_remove','remove','outcome_begin','outcome_cancel','outcome_query','trigger_begin','trigger_cancel','trigger_cleanup','trigger_delete_draft','trigger_delete_draft_cleanup']);
export const getCoreExperimentContext=()=>contexts.getStore();
export function requireCoreExperimentContext():CoreExperimentContext {
 const context=contexts.getStore();if(!context)throw Object.assign(new Error('Trusted Experiment repository scope required'),{status:503});return context;
}
export function runWithCoreExperimentContext<T>(context:CoreExperimentContext,action:()=>Promise<T>):Promise<T>{return contexts.run(context,()=>runWithCoreControlActor(context.actor,context.options,action));}
export function coreExperimentFailure(cause:unknown):Response {
 const status=cause&&typeof cause==='object'&&'status'in cause&&typeof cause.status==='number'&&[400,401,403,404,409,410,413,422,428,429,503].includes(cause.status)?cause.status:502;
 const messages:Record<number,string>={400:'实验请求参数无效',401:'请重新登录后操作',403:'无权访问该实验',404:'未找到实验或评测结果',409:'实验数据或运行状态已更新，请刷新后重试',410:'实验请求已过期',413:'实验数据超过当前请求预算',422:'实验输入或来源尚不可用',428:'缺少数据版本，请重新加载后再试',429:'实验任务已满，请稍后重试',503:'实验存储服务暂时不可用'};
 return Response.json({error:messages[status]||'实验存储请求失败'},{status,headers:{'cache-control':'no-store'}});
}
export async function withCoreExperiments<T>(request:Request,action:()=>Promise<T>,options:CompatibilityOptions={},configuredActor?:CoreBackgroundActor):Promise<T>{
 if(!options.fetcher&&!options.resolveIdentity&&getCoreExperimentContext())options=getCoreExperimentContext()!.options;
 const identity=await compatibilityContext(request,options);if(!identity.username)throw Object.assign(new Error('Verified Experiment identity required'),{status:403});
 if(configuredActor){if(!isVerifiedCoreBackgroundActor(configuredActor)||identity.principal!==configuredActor.principal||identity.workspace!==configuredActor.workspace||identity.token!==configuredActor.token||identity.principalUsername!==configuredActor.principalUsername)throw Object.assign(new Error('Configured background identity changed'),{status:403});identity.username=configuredActor.username;}
 const actor=Object.freeze({...identity,username:identity.username});let body:Record<string,unknown>={};
 if(request.body){
  const raw=await readCoreBytes(request.clone().body,LIMIT);
  if(raw.length){try{const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();body=parsed;}catch{throw Object.assign(new Error('JSON object required'),{status:400});}}
 }
 const operationKey=request.headers.get('idempotency-key')||randomUUID();if(!/^[\x21-\x7e]{1,512}$/.test(operationKey))throw Object.assign(new Error('Invalid operation key'),{status:400});
 const operationRequest={method:request.method,path:new URL(request.url).pathname,ifMatch:request.headers.get('if-match'),body};
 const rpc=async(actionName:string,payload:Record<string,unknown>={})=>{
  const data=JSON.stringify({...payload,action:actionName,...(mutations.has(actionName)?{operation_key:payload.operation_key||operationKey,operation_request:payload.operation_request||operationRequest}:{})});
  if(Buffer.byteLength(data,'utf8')>LIMIT)throw Object.assign(new Error('Experiment request too large'),{status:413});
  let controller:Record<string,string>={};
  const config=payload.config;
  if(['start','execute_start','outcome_begin','trigger_begin'].includes(actionName)&&config&&typeof config==='object'&&('core_flow_analysis' in config||'core_outcome' in config||Array.isArray((config as Record<string,unknown>).derived_skill_ids)&&((config as Record<string,unknown>).derived_skill_ids as unknown[]).length)){
   const {validateControllerSkillScope,controllerHeaders}=await import('./controller');if(Array.isArray((config as Record<string,unknown>).derived_skill_ids)&&((config as Record<string,unknown>).derived_skill_ids as unknown[]).length)await validateControllerSkillScope(actor.username,config as Record<string,unknown>);controller=await controllerHeaders(actor,data,'experiment-frozen-assets/v1');
  }
  if(actionName==='outcome_query'||['trigger_cleanup','trigger_delete_draft_cleanup'].includes(actionName)||actionName==='checkpoint'&&(['trigger_samples','trigger_started_at_ms','trigger_finished_at_ms','trigger_runtime_closed'].some(name=>Object.hasOwn(payload.checkpoint as Record<string,unknown>||{},name))||payload.trigger_draft===true&&Object.hasOwn(payload.checkpoint as Record<string,unknown>||{},'_flow_model_calls'))){const {controllerHeaders}=await import('./controller');controller=await controllerHeaders(actor,data,'experiment-frozen-assets/v1');}
  if(actionName==='complete'&&['coreOutcome','coreTriggerResult','coreTriggerDraft'].some(name=>Object.hasOwn((payload.result as {evidence?:{json?:Record<string,unknown>}}|undefined)?.evidence?.json||{},name))){const {controllerHeaders}=await import('./controller');controller=await controllerHeaders(actor,data,'experiment-frozen-assets/v1');}
  if(['execute_start','execute_complete','execute_fail'].includes(actionName)||actionName==='start'&&payload.source_execution_run_id!==undefined||actionName==='checkpoint'&&((payload.checkpoint as Record<string,unknown>|undefined)?.cleanup_confirmed===true||['runtime_started_at_ms','runtime_finished_at_ms'].some(name=>Object.hasOwn(payload.checkpoint as Record<string,unknown>||{},name)))){const {controllerHeaders}=await import('./controller');controller=await controllerHeaders(actor,data,'experiment-execution/v1');}
  if(actionName==='cancellation_update'){const {controllerHeaders}=await import('./controller');controller=await controllerHeaders(actor,data,'experiment-cancellation/v1');}
  if(actionName==='derived_issue_resolve'){const {controllerHeaders}=await import('./controller');controller=await controllerHeaders(actor,data,'experiment-frozen-assets/v1');}
  const path='/v1/compat/experiments?'+new URLSearchParams({workspace_id:actor.workspace});
  for(let attempt=0;attempt<3;attempt++){
   try{const response=await requestCore(path,{token:actor.token,method:'POST',body:data,responseLimit:LIMIT,timeoutMs:120_000,headers:controller},options.fetcher||fetch);if(!Object.hasOwn(response.data,'value'))throw Object.assign(new Error('Invalid Experiment response'),{status:502});return response.data.value;}
   catch(cause){const status=cause&&typeof cause==='object'&&'status'in cause?cause.status:undefined;if(attempt===2||(status!==undefined&&status!==502&&status!==503))throw cause;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}
  }
  throw Object.assign(new Error('Experiment storage unavailable'),{status:503});
 };
 return contexts.run({actor,request,options,operationKey,body,rpc},()=>runWithCoreControlActor(actor,options,action));
}

export async function withCoreConfiguredExperiments<T>(actor:CoreBackgroundActor,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 if(!isVerifiedCoreBackgroundActor(actor))throw Object.assign(new Error('Verified private background identity required'),{status:403});
 await (await import('./compat')).revalidateConfiguredCoreBackgroundActor(actor,options);
 const request=new Request('http://localhost/internal/storage-core/experiments?'+new URLSearchParams({workspace_id:actor.workspace}),{headers:{authorization:'Bearer '+actor.token}});
 return withCoreExperiments(request,action,options,actor);
}

export function experimentReadSource<T>(legacy:T):T {
 const context=getCoreExperimentContext();if(context?.readView)return context.readView as T;
 if(context||isStorageCoreEnabled())throw Object.assign(new Error('Complete core Experiment read view required'),{status:503});
 return legacy;
}
export async function withCoreExperimentReadRoute<T>(request:Request,handler:(request:Request)=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 options=getCoreExperimentContext()?.options||options;
 return withCoreExperiments(request,async()=>{
  const context=requireCoreExperimentContext();const requestUrl=new URL(request.url);const path=requestUrl.pathname;const match=/^\/api\/experiments\/([^/]+)$/.exec(path);
  const listView=['/api/experiments','/api/experiments/eval-runs','/api/experiments/eval-results'].includes(path);
  const payload=path==='/api/experiments/eval-results'?{...(requestUrl.searchParams.get('runId')?{experiment_id:requestUrl.searchParams.get('runId')!}:{}),...(requestUrl.searchParams.get('taskId')?{task_id:requestUrl.searchParams.get('taskId')!}:{})}:match&&!collectionRoutes.has(match[1])?{experiment_id:decodeURIComponent(match[1])}:{};
  let result=await context.rpc(listView?'list_view':'read_view',payload) as {coverage:string;snapshots:ExperimentViewSnapshot[]};
  if(!result||result.coverage!=='complete'||!Array.isArray(result.snapshots))throw Object.assign(new Error('Complete Experiment read view required'),{status:503});
  if(!listView&&match&&'experiment_id'in payload&&result.snapshots.some(snapshot=>snapshot.experiment.id===payload.experiment_id&&snapshot.experiment.scope==='benchmark')){
   const {benchmarkCoreRpc}=await import('@/lib/benchmark/core-store');
   result=await benchmarkCoreRpc('read_view',{experiment_id:payload.experiment_id});
   if(result?.coverage!=='complete'||!Array.isArray(result.snapshots)||result.snapshots.length!==1||result.snapshots[0].experiment.id!==payload.experiment_id||result.snapshots[0].experiment.scope!=='benchmark'||!Array.isArray(result.snapshots[0].benchmark_runs))throw Object.assign(new Error('Complete Benchmark detail read view required'),{status:503});
  }
  const view=createExperimentReadView(result.snapshots,{actorUsername:context.actor.username});
  context.readView=listView?new Proxy(view,{get(target,model){if(typeof model!=='string'||model==='then')return undefined;if(!['experiment','experimentCase','experimentEvalResult'].includes(model))throw Object.assign(new Error('Experiment list projection does not cover this source'),{status:503});return Reflect.get(target,model);}}):view;
  const url=new URL(request.url);url.searchParams.set('user',context.actor.username);
  return runWithCoreDatasetActor(context.actor,request,()=>runWithCoreEvaluatorActor(context.actor,()=>handler(new Request(url,{method:'GET',headers:request.headers})),options),options);
 },options);
}

export async function prepareCoreExperimentRuntime<T>(context:CoreExperimentContext,raw:unknown,action:()=>Promise<T>,runtimeOptions:{signal?:AbortSignal;publicExecution?:boolean;modelConfiguration?:import('@/lib/storage/server-config').ModelConfig}={}):Promise<T>{
 const work=raw as {handle:Record<string,unknown>;runplan?:{config?:{model_selection?:Record<string,unknown>|null}}};
 if(!work?.handle)throw Object.assign(new Error('Frozen Experiment work handle required'),{status:503});
 if(runtimeOptions.publicExecution&&work.handle.phase!=='execute')throw Object.assign(new Error('Business Agent runtime requires an execution handle'),{status:503});
 const selection=work.runplan?.config?.model_selection;let model:import('@/lib/storage/server-config').ModelConfig|null=null;
 if(selection){
  if(runtimeOptions.modelConfiguration)model=runtimeOptions.modelConfiguration;
  else{const {getUserSettings}=await import('@/lib/storage/server-config');const settings=await getUserSettings(context.actor.username);model=settings.configs.find(candidate=>candidate.id===selection.id)||null;}
  if(!model||!matchesFrozenModelSelection(model,selection))throw Object.assign(new Error('Frozen model connection changed or is unavailable'),{status:503});
 }
 const recordCoreTrace:import('@/lib/engine/evaluation/evaluator-execution-recorder').CoreTraceRecorder=async payload=>{
  const handle=work.handle;const origin=handle.diagnosis_id?{diagnosis_run_id:handle.diagnosis_id,diagnosis_attempt_id:handle.attempt_id,diagnosis_fence:handle.fence,diagnosis_lease_owner:handle.lease_owner}:{experiment_id:handle.experiment_id,experiment_attempt_id:handle.attempt_id,experiment_fence:handle.fence,experiment_lease_owner:handle.lease_owner,...(runtimeOptions.publicExecution?{experiment_recording_kind:'execution'}:{})};const {data}=await requestCore('/v1/compat/observe/agent-traces?'+new URLSearchParams({workspace_id:context.actor.workspace}),{
   token:context.actor.token,method:'POST',body:JSON.stringify({...payload,context:origin}),timeoutMs:295_000,responseLimit:1024*1024,
  },context.options.fetcher||fetch);
  const receipt=data.value as {state?:string;task_id?:string};if(receipt?.state!=='indexed'||receipt.task_id!==payload.record.task_id)throw Object.assign(new Error('Experiment Judge Trace is not indexed'),{status:503});
 };
 const {runWithFrozenModelConfiguration}=await import('./frozen-model');
 const scoped={...context,recordCoreTrace,cancelSignal:runtimeOptions.signal};
 return runWithCoreExperimentContext(scoped,()=>runWithCoreDatasetActor(context.actor,context.request,()=>runWithCoreEvaluatorActor(context.actor,()=>runWithFrozenModelConfiguration(context.actor.username,model,async()=>{
  if(!model)return action();
  const {resolveAgentInsightHomePath}=await import('@/lib/env');const {mkdir}=await import('node:fs/promises');
  const handle=work.handle;for(const key of ['run_id','attempt_id'])if(typeof handle[key]!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(handle[key] as string))throw Object.assign(new Error('Invalid Experiment workspace identity'),{status:503});
  const directory=resolveAgentInsightHomePath('workspaces',handle.diagnosis_id?'diagnoses':'experiments',handle.run_id as string,handle.attempt_id as string);await mkdir(directory,{recursive:true,mode:0o700});
  const {runWithTrustedCoreAgentContext}=await import('@/lib/engine/general-agent/trusted-context');
  const {resolveGeneralAgentModel}=await import('@/lib/engine/general-agent/runner');const trustedModel=await resolveGeneralAgentModel(context.actor.username);
  return runWithTrustedCoreAgentContext({trustedWorkspaceDir:directory,trustedModel,recordCoreTrace,cancelSignal:runtimeOptions.signal},action);
 }),context.options),context.options));
}

export async function withCoreExperimentMutationRoute(request:Request,handler:(request:Request)=>Promise<Response>,options:CompatibilityOptions={}):Promise<Response>{
 const act=async()=>{
  const context=requireCoreExperimentContext();const url=new URL(request.url);url.searchParams.set('user',context.actor.username);const headers=new Headers(request.headers);headers.delete('content-length');
  const hasBody=request.body!==null&&Object.keys(context.body).length>0||['POST','PUT','PATCH'].includes(request.method);
  const normalized=new Request(url,{method:request.method,headers,...(hasBody?{body:JSON.stringify({...context.body,user:context.actor.username})}:{})});
  const resource=/^\/api\/experiments\/([^/]+)/.exec(url.pathname);
  if(resource&&!collectionRoutes.has(resource[1])&&!context.readView&&request.method!=='DELETE')await ensureCoreExperimentReadView(context,decodeURIComponent(resource[1]));
  const previous=context.compatibilityRoute;context.compatibilityRoute=true;
  try{return await runWithCoreDatasetActor(context.actor,context.request,()=>runWithCoreEvaluatorActor(context.actor,()=>handler(normalized),context.options),context.options);}finally{context.compatibilityRoute=previous;}
 };
 try{return getCoreExperimentContext()?await act():await withCoreExperiments(request,act,options);}catch(cause){return coreExperimentFailure(cause);}
}
export async function createCoreExperimentRecord(input:unknown):Promise<{id:string}>{
 const context=requireCoreExperimentContext();if(!input||typeof input!=='object'||Array.isArray(input))throw Object.assign(new Error('Experiment record required'),{status:400});
 const receipt=await lookupCoreExperimentOperation(context,'create');
 if(receipt){const id=(receipt.experiment as {id?:unknown})?.id;if(typeof id!=='string')throw Object.assign(new Error('Invalid Experiment creation receipt'),{status:502});return {id};}
 const data=input as Record<string,unknown>;const cases=Array.isArray(data.cases)?data.cases:(data.cases as {create?:unknown})?.create||[];const groups=Array.isArray(data.groups)?data.groups:(data.groups as {create?:unknown})?.create||[];
 const {freezeExperimentAssets}=await import('./experiment-assets');const prepared=await freezeExperimentAssets(context,{...data,user:context.actor.username,cases,groups});
 const result=await context.rpc('create',{experiment:prepared}) as {experiment:{id:string}};if(typeof result?.experiment?.id!=='string')throw Object.assign(new Error('Invalid Experiment creation result'),{status:502});return {id:result.experiment.id};
}

export function coreExperimentOperationRequest(context:CoreExperimentContext):Record<string,unknown>{
 return {method:context.request.method,path:new URL(context.request.url).pathname,ifMatch:context.request.headers.get('if-match'),body:context.body};
}

export async function lookupCoreExperimentOperation(context:CoreExperimentContext,kind:string,key=context.operationKey,request=coreExperimentOperationRequest(context)):Promise<Record<string,unknown>|null>{
 const receipt=await context.rpc('lookup_operation',{operation_kind:kind,operation_key:key,operation_request:request}) as {found:boolean;result?:Record<string,unknown>};
 if(receipt?.found===false)return null;
 if(receipt?.found===true&&receipt.result&&typeof receipt.result==='object')return receipt.result;
 throw Object.assign(new Error('Experiment operation receipt unavailable'),{status:503});
}

export async function ensureCoreExperimentReadView(context:CoreExperimentContext,experimentId?:string):Promise<void>{
 const result=await context.rpc('read_view',experimentId?{experiment_id:experimentId}:{}) as {coverage:string;snapshots:ExperimentViewSnapshot[]};
 if(result?.coverage!=='complete'||!Array.isArray(result.snapshots))throw Object.assign(new Error('Complete Experiment read view required'),{status:503});
 context.readView=createExperimentReadView(result.snapshots,{actorUsername:context.actor.username});
}
export async function writeCoreExperimentReview(experimentId:string,resultId:string,humanScore:unknown,reason:string):Promise<Record<string,unknown>>{
 const result=await requireCoreExperimentContext().rpc('review',{experiment_id:experimentId,result_id:resultId,human_score:humanScore,human_reason:reason}) as {experiment:{cases:Array<{results:Array<Record<string,unknown>>}>}};
 const row=result?.experiment?.cases.flatMap(item=>item.results).find(item=>item.id===resultId);if(!row)throw Object.assign(new Error('Reviewed result unavailable'),{status:503});
 return Object.fromEntries(['id','score','humanScore','humanReason','humanBy','humanAt'].map(key=>[key,row[key]??null]));
}
