import {runWithCoreControlActor} from './control-context';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {compatibilityContext,type CompatibilityOptions} from './compat';
import {readCoreBytes,requestCore} from './server';
import {isStorageCoreEnabled} from './mode';

export interface CoreEvaluatorActor {token:string;workspace:string;principal:string;username:string|null}
export interface CoreEvaluatorRelease {evaluator_id:string;asset_id:string;release_id:string;content_hash:string;origin:'user'}
export interface CoreEvaluatorSnapshot {evaluators:Record<string,unknown>[];releases:CoreEvaluatorRelease[];etag:string;list_release_id:string|null}
export interface FrozenCoreEvaluators {schemaVersion:1;cards:Record<string,Record<string,unknown>>;releases:CoreEvaluatorRelease[];list_etag:string}
interface Context {actor:CoreEvaluatorActor&{username:string};options:CompatibilityOptions;request?:Request;body:Record<string,unknown>;operationKey:string;snapshot?:CoreEvaluatorSnapshot}
const contextKey=Symbol.for('agent-insight.storage-core.evaluator-context');
const globalContexts=globalThis as unknown as Record<symbol,AsyncLocalStorage<Context>>;
const contexts=globalContexts[contextKey] ||= new AsyncLocalStorage<Context>();const LIMIT=8*1024*1024;
const failure=(status:number,message:string)=>Object.assign(new Error(message),{status});
export const getCoreEvaluatorContext=()=>contexts.getStore();
export function getEvaluatorRepositoryContext(){const context=contexts.getStore();if(!context&&isStorageCoreEnabled())throw failure(503,'Trusted evaluator scope required');return context;}
export function requireCoreEvaluatorContext(){const context=contexts.getStore();if(!context)throw failure(503,'Trusted evaluator scope required');return context;}
function snapshot(value:unknown):CoreEvaluatorSnapshot {
 if(!value||typeof value!=='object'||Array.isArray(value))throw failure(502,'Invalid evaluator response');
 const row=value as CoreEvaluatorSnapshot;
 if(!Array.isArray(row.evaluators)||row.evaluators.length>1000||row.evaluators.some(card=>!card||typeof card!=='object'||Array.isArray(card)||typeof card.id!=='string')||new Set(row.evaluators.map(card=>card.id)).size!==row.evaluators.length||!Array.isArray(row.releases)||row.releases.length!==row.evaluators.length||typeof row.etag!=='string'||!/^"[\x21\x23-\x7e]{1,510}"$/.test(row.etag))throw failure(502,'Invalid evaluator snapshot');
 return row;
}
export async function withCoreEvaluators<T>(request:Request,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 const actor=await compatibilityContext(request,options);if(!actor.username)throw failure(403,'Verified evaluator identity required');
 let body:Record<string,unknown>={};
 if(request.body){const raw=await readCoreBytes(request.clone().body,LIMIT);if(raw.length){try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();body=value;}catch{throw failure(400,'Invalid evaluator JSON');}}}
 const operationKey=request.headers.get('idempotency-key')||randomUUID();if(!/^[\x21-\x7e]{1,512}$/.test(operationKey))throw failure(400,'Invalid evaluator operation key');
 return contexts.run({actor:{...actor,username:actor.username},options,request,body,operationKey},()=>runWithCoreControlActor({...actor,username:actor.username!},options,action));
}
export async function runWithCoreEvaluatorActor<T>(actor:CoreEvaluatorActor,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 const request=new Request('http://localhost/internal/evaluators?'+new URLSearchParams({workspace_id:actor.workspace}),{headers:{authorization:'Bearer '+actor.token}});
 return withCoreEvaluators(request,async()=>{
  const context=requireCoreEvaluatorContext();if(context.actor.principal!==actor.principal)throw failure(403,'Evaluator actor differs');
  if(!actor.username)throw failure(403,'Evaluator model owner required');context.actor={...context.actor,username:actor.username};return action();
 },options);
}
async function rpc(action:string,payload:Record<string,unknown>={}):Promise<unknown>{
 const context=requireCoreEvaluatorContext();const body=JSON.stringify({action,...payload});if(Buffer.byteLength(body,'utf8')>3*LIMIT)throw failure(413,'Evaluator exceeds byte budget');
 for(let attempt=0;attempt<3;attempt++){
  try{const {data}=await requestCore('/v1/compat/evaluators?'+new URLSearchParams({workspace_id:context.actor.workspace}),{token:context.actor.token,method:'POST',body,responseLimit:LIMIT,timeoutMs:65_000},context.options.fetcher||fetch);if(!Object.hasOwn(data,'value'))throw failure(502,'Invalid evaluator response');return data.value;}
  catch(cause){const status=cause&&typeof cause==='object'&&'status'in cause?cause.status:undefined;if(attempt===2||(status!==undefined&&status!==502&&status!==503))throw cause;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}
 }
 throw failure(503,'Evaluator storage unavailable');
}
export async function readCoreEvaluators():Promise<unknown[]>{
 const context=requireCoreEvaluatorContext();context.snapshot??=snapshot(await rpc('read'));return context.snapshot.evaluators;
}
function expectedEtag(){const context=requireCoreEvaluatorContext();const value=context.request?.headers.get('if-match')||(typeof context.body._storageEtag==='string'?context.body._storageEtag:undefined);if(!value)throw failure(428,'Evaluator version required');return value;}
function operationRequest(){const context=requireCoreEvaluatorContext();return {method:context.request?.method,path:context.request?new URL(context.request.url).pathname:undefined,body:context.body,ifMatch:expectedEtag()};}
export async function saveCoreEvaluators(evaluators:unknown[]):Promise<CoreEvaluatorSnapshot>{
 const context=requireCoreEvaluatorContext();const expected=expectedEtag();
 const result=snapshot(await rpc('save',{evaluators,expected_etag:expected,operation_key:context.operationKey,operation_request:operationRequest()}));context.snapshot=result;return result;
}
function safeDefinition(value:unknown):void {
 if(Array.isArray(value)){value.forEach(safeDefinition);return;}
 if(value&&typeof value==='object')for(const [key,item] of Object.entries(value)){const normalized=key.toLowerCase().replace(/[^a-z0-9]/g,'');if(['authorization','proxyauthorization','cookie','setcookie','token'].includes(normalized)||/(?:apikey|accesstoken|refreshtoken|secret|password|credential|privatekey)$/.test(normalized))throw failure(503,'Unsafe evaluator definition');safeDefinition(item);}
}
export async function freezeCoreEvaluators(ids:string[],expected?:string):Promise<FrozenCoreEvaluators>{
 const value=await rpc('freeze',{evaluator_ids:ids,...(expected?{expected_etag:expected}:{})}) as FrozenCoreEvaluators;
 if(!value||value.schemaVersion!==1||!value.cards||typeof value.cards!=='object'||Array.isArray(value.cards)||!Array.isArray(value.releases)||value.releases.length!==ids.length||Object.keys(value.cards).length!==ids.length||typeof value.list_etag!=='string')throw failure(503,'Invalid frozen evaluators');
 for(const id of ids){const card=value.cards[id];const release=value.releases.find(row=>row.evaluator_id===id);if(!card||card.id!==id||card.source!=='custom'||!release||release.origin!=='user'||typeof release.asset_id!=='string'||typeof release.release_id!=='string'||!/^[0-9a-f]{64}$/.test(release.content_hash))throw failure(503,'Evaluator release differs');safeDefinition(card);}
 const context=requireCoreEvaluatorContext();
 const {EvaluatorSkillStore}=await import('@/lib/evaluators/evaluator-skill-store');const store=new EvaluatorSkillStore();
 for(const card of Object.values(value.cards)){
  const config=card.llmConfig&&typeof card.llmConfig==='object'?card.llmConfig as {skills?:unknown}:undefined;
  if(config?.skills!==undefined&&!Array.isArray(config.skills))throw failure(503,'Invalid evaluator Skills');
  for(const skill of (config?.skills||[]) as Array<{name?:unknown;snapshotHash?:unknown}>){
   if(!skill||typeof skill.name!=='string'||typeof skill.snapshotHash!=='string'||!/^[0-9a-f]{64}$/.test(skill.snapshotHash))throw failure(503,'Unfrozen evaluator Skill');
   const loaded=await store.load(context.actor.username,skill.snapshotHash);if(loaded.manifest.name!==skill.name)throw failure(503,'Evaluator Skill name differs');
  }
 }
 return value;
}
export function coreEvaluatorFailure(cause:unknown):Response {
 const status=cause&&typeof cause==='object'&&'status'in cause&&typeof cause.status==='number'?cause.status:502;
 return Response.json({error:status===428?'缺少读取版本，请重新加载后再试':status===409?'评估器已更新，请重新加载后再试':status===401?'Authentication required':status===403?'Forbidden':'Evaluator storage unavailable'},{status,headers:{'cache-control':'no-store'}});
}
export async function withCoreEvaluatorRoute(request:Request,next:(request:Request)=>Promise<Response>,options:CompatibilityOptions={}):Promise<Response>{
 try{return await withCoreEvaluators(request,async()=>{
  const context=requireCoreEvaluatorContext();
  if(request.method==='PUT'){
   const prior=await rpc('lookup',{operation_key:context.operationKey,expected_etag:expectedEtag(),operation_request:operationRequest()});
   if(prior){context.snapshot=snapshot(prior);return Response.json({success:true,evaluators:context.snapshot.evaluators},{headers:{etag:context.snapshot.etag,'cache-control':'no-store'}});}
  }
  const url=new URL(request.url);url.searchParams.set('user',context.actor.username);const headers=new Headers(request.headers);headers.delete('content-length');
  const normalized=new Request(url,{method:request.method,headers,...(request.body?{body:JSON.stringify({...context.body,user:context.actor.username})}:{})});
  const response=await next(normalized);const out=new Headers(response.headers);out.set('cache-control','no-store');if(context.snapshot)out.set('etag',context.snapshot.etag);
  return new Response(response.body,{status:response.status,headers:out});
 },options);}catch(cause){return coreEvaluatorFailure(cause);}
}
