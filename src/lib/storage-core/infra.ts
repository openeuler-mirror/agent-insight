import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {compatibilityContext,compatibilityFailure,configuredCoreBackgroundActorForUser,configuredCoreBackgroundActors,isVerifiedCoreBackgroundActor,type CoreBackgroundActor,type CompatibilityOptions} from './compat';
import {coreCookieName,coreServiceOrigin,requestCore} from './server';
import {controllerHeaders} from './controller';
import {readCoreAnalytics} from './analytics';
import type {InfraSource} from '@prisma/client';

type Actor={token:string;principal:string;workspace:string;username:string|null;principalUsername?:string|null};
interface Context {actor:Actor;origin:string;fetcher:typeof fetch;executions?:Promise<InfraExecution[]>}
export interface InfraExecution {id:string;taskId:string|null;timestamp:Date;latency:number|null;model:string|null;endpoint:string|null;rootExecutionId:string|null;outputTokens:number|null;agentName:string|null}
const storage=new AsyncLocalStorage<Context>();
const rejectedIngest=new AsyncLocalStorage<boolean>();
const fail=(message:string,status=503)=>Object.assign(new Error(message),{status});
export const hasCoreInfraContext=()=>storage.getStore()!==undefined||rejectedIngest.getStore()===true;
function context(){const value=storage.getStore();if(!value)throw fail('Verified Infra request context required',403);return value;}
function pinned(origin:string,transport:typeof fetch):typeof fetch{return async(input,init)=>{if(coreServiceOrigin()!==origin||new URL(input instanceof Request?input.url:String(input)).origin!==origin)throw fail('Infra storage origin changed');const response=await transport(input,init);if(coreServiceOrigin()!==origin){void response.body?.cancel();throw fail('Infra storage origin changed');}return response;};}
function cookieRequest(request:Request){
 const url=new URL(request.url),headers=new Headers(request.headers),workspaces=url.searchParams.getAll('workspace_id'),workspace=headers.get('x-workspace-id');
 if(workspaces.length>1)throw fail('Duplicate Infra workspace',400);
 if(workspace&&workspaces.length&&workspace!==workspaces[0])throw fail('Infra workspace differs',403);
 if(workspace)url.searchParams.set('workspace_id',workspace);
 if(!headers.has('authorization')&&!headers.has('x-witty-api-key')){
  const name=coreCookieName(),matches=(headers.get('cookie')||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(name+'='));
  if(matches.length===1){const token=matches[0].slice(name.length+1);if(/^session_[A-Za-z0-9_-]{43}$/.test(token))headers.set('authorization','Bearer '+token);}
 }
 return new Request(url,{headers});
}
export async function withCoreInfraRequest(request:Request,handler:()=>Promise<Response>,options:CompatibilityOptions={}):Promise<Response>{
 try{const origin=coreServiceOrigin(),fetcher=pinned(origin,options.fetcher||fetch),actor=await compatibilityContext(cookieRequest(request),{...options,fetcher});return await storage.run({actor,origin,fetcher},handler);}catch(error){return compatibilityFailure(error);}
}
export async function withCoreInfraBackground<T>(actor:CoreBackgroundActor,handler:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 if(!isVerifiedCoreBackgroundActor(actor))throw fail('Verified Infra background identity required',403);
 const origin=coreServiceOrigin(),fetcher=pinned(origin,options.fetcher||fetch);return storage.run({actor,origin,fetcher},handler);
}
export async function withConfiguredCoreInfraActor<T>(handler:()=>Promise<T>):Promise<T>{
 const username=process.env.DEFAULT_INGEST_USER?.trim();if(!username)throw fail('Explicit Infra ingestion identity required',403);
 const actor=await configuredCoreBackgroundActorForUser(username);return withCoreInfraBackground(actor,handler);
}
export async function withCoreInfraIngest(request:Request,handler:()=>Promise<Response>):Promise<Response>{
 let current:Context;
 try{
  if(request.headers.has('authorization')||request.headers.has('x-witty-api-key')||(request.headers.get('cookie')||'').split(';').some(value=>value.trim().startsWith(coreCookieName()+'='))){
   const origin=coreServiceOrigin(),fetcher=pinned(origin,fetch),actor=await compatibilityContext(cookieRequest(request),{fetcher});current={actor,origin,fetcher};
  }else{
   const username=process.env.DEFAULT_INGEST_USER?.trim();if(!username)throw fail('Explicit Infra ingestion identity required',403);
   const actor=await configuredCoreBackgroundActorForUser(username),origin=coreServiceOrigin();current={actor,origin,fetcher:pinned(origin,fetch)};
  }
 }catch{return rejectedIngest.run(true,handler);}
 return storage.run(current,handler);
}
export async function pollCoreInfraOwners<T extends {polled:number;failed:number;skipped?:number;errors:Array<{endpoint:string;error:string}>}>(handler:()=>Promise<T>){
 const result={polled:0,failed:0,skipped:0,errors:[] as Array<{endpoint:string;error:string}>};
 const configured=await configuredCoreBackgroundActors();
 for(const actor of configured.actors){try{const row=await withCoreInfraBackground(actor,handler);result.polled+=row.polled;result.failed+=row.failed;result.skipped+=row.skipped||0;result.errors.push(...row.errors);}catch{result.failed++;result.errors.push({endpoint:'[configured Infra owner] ',error:'Owner unavailable or not authorized'});}}
 result.failed+=configured.failures.length;return result;
}
async function rpc<T>(action:string,payload:Record<string,unknown>={}):Promise<T>{
 const current=context(),body=JSON.stringify({action,payload});
 const result=await requestCore('/v1/compat/infra?'+new URLSearchParams({workspace_id:current.actor.workspace}),{token:current.actor.token,method:'POST',body,headers:await controllerHeaders(current.actor,body,'infra/v1'),responseLimit:16*1024*1024,timeoutMs:30_000},current.fetcher);
 if(!Object.hasOwn(result.data,'value'))throw fail('Infra response unavailable');return result.data.value as T;
}
function source(value:InfraSource|null):InfraSource|null{return value?{...value,createdAt:new Date(value.createdAt),updatedAt:new Date(value.updatedAt)}:null;}
export const coreInfraOwnerKey=()=>{const current=context();return current.actor.workspace+'\0'+current.actor.principal+'\0';};
export const authorizeCoreInfra=(capability='read')=>rpc('scope',{capability});
export const getCoreInfraIngestSource=(endpoint:string|null,model:string|null)=>rpc<InfraSource>('ingest_source',{endpoint,model});
export async function listCoreInfraSources(ownOnly=false,liveOnly=false){return (await rpc<InfraSource[]>('list',{own_only:ownOnly,live_only:liveOnly})).map(row=>source(row)!);}
export const assertCoreInfraPollable=(sourceId:string)=>rpc('pollable',{source_id:sourceId});
export async function getCoreInfraSource(where:{id?:string;endpoint?:string;ownerExecution?:string}){return source(await rpc<InfraSource|null>('get',{...(where.id?{source_id:where.id}:{endpoint:where.endpoint}),...(where.ownerExecution?{owner_execution:where.ownerExecution}:{})}));}
export async function ensureCoreInfraSource(input:Record<string,unknown>){return source(await rpc<InfraSource>('ensure',input))!;}
export async function patchCoreInfraSource(id:string,data:Record<string,unknown>){return source(await rpc<InfraSource>('patch',{id,data}))!;}
export async function deleteCoreInfraSource(where:{id?:string;endpoint?:string}){return rpc<number>('delete',where.id?{source_id:where.id}:{endpoint:where.endpoint});}
export async function saveCoreInfraSample(sourceId:string,row:Record<string,unknown>){
 const operation=randomUUID(),sample_json=JSON.stringify(row);await rpc('accept',{source_id:sourceId,operation,sample_json});
 const deadline=Date.now()+25_000;
 for(;;){const value=await rpc<{state:string}>('status',{source_id:sourceId,operation});if(value.state==='indexed')return;if(Date.now()>deadline)throw fail('Infra sample remains pending');await new Promise(resolve=>setTimeout(resolve,50));}
}
export interface InfraStoredSample {tsMs:number;via:string;model:string|null;gauges:string;counters:string;histograms:string;waitingByReason:string|null;source:{endpoint:string}}
export async function queryCoreInfraSamples(sourceId:string,options:{fromMs?:number;toMs?:number;model?:string;via?:string;n?:number;order?:'asc'|'desc'}={}){
 const rows:InfraStoredSample[]=[];let after:Record<string,unknown>|undefined;
 for(;;){const result=await rpc<{rows:InfraStoredSample[];cursor:Record<string,unknown>|null}>('samples',{source_id:sourceId,...(options.fromMs!==undefined?{from_ms:options.fromMs}:{}),...(options.toMs!==undefined?{to_ms:options.toMs}:{}),...(options.model?{model:options.model}:{}),...(options.via?{via:options.via}:{}),limit:Math.min(512,options.n===undefined?512:options.n-rows.length),order:options.order||'asc',...(after?{after}:{})});rows.push(...result.rows);if(!result.cursor||options.n!==undefined&&rows.length>=options.n)return rows;after=result.cursor;}
}
export const getCoreInfraLinks=(executionId:string)=>rpc<Array<{sourceId:string;model:string|null}>>('get_links',{execution_id:executionId});
export const setCoreInfraLinks=(executionId:string,links:Array<{sourceId:string;model:string|null}>)=>rpc('set_links',{execution_id:executionId,links});
export async function readCoreInfraExecutions():Promise<InfraExecution[]>{
 const current=context();
 return current.executions ||= (async()=>{
  const request=new Request('http://localhost/api/observe/infra/internal',{headers:{authorization:'Bearer '+current.actor.token}}),url=new URL(request.url);url.searchParams.set('workspace_id',current.actor.workspace);
  const analytics=await readCoreAnalytics(new Request(url,{headers:request.headers}),{fetcher:current.fetcher}),endpoints=new Map<string,string|null>();
  for(let offset=0;offset<analytics.items.length;offset+=100){const selected=analytics.items.slice(offset,offset+100),items=await rpc<Array<{trace_id:string;boundary:string;endpoint:string|null}>>('endpoints',{items:selected.map(row=>({trace_id:row.trace_id,boundary:row.boundary}))});
   if(items.length!==selected.length)throw fail('Infra endpoint coverage unavailable');
   items.forEach((item,i)=>{if(item.trace_id!==selected[i].trace_id||item.boundary!==selected[i].boundary||item.endpoint!==null&&typeof item.endpoint!=='string')throw fail('Infra endpoint source differs',409);endpoints.set(selected[i].projection.executions[0].id,item.endpoint);});
  }
  await analytics.validate();return analytics.rows.map(row=>({id:row.id,taskId:row.taskId,timestamp:row.timestamp,latency:row.latency,model:row.model,endpoint:endpoints.get(row.id)??null,rootExecutionId:row.rootExecutionId,outputTokens:row.outputTokens,agentName:row.agentName}));
 })();
}
