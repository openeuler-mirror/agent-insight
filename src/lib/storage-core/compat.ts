import {controllerHeaders} from './controller';
import {recordVerifiedCoreUsage} from './usage';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { coreServiceOrigin, handleCoreIngest, readCoreBytes, requestCore } from './server';

interface Identity { username: string | null; apiKey: string | null }
interface Binding { legacy_api_key_sha256: string; legacy_username: string; principal_id: string; workspace_id: string; credential: string }
export interface CompatibilityOptions { fetcher?: typeof fetch; resolveIdentity?: (request: Request) => Promise<Identity> }
class CompatibilityError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const IAM_TOKEN=/^(session|api)_[A-Za-z0-9_-]{43}$/;
const DATA_FIELDS=['query','taskId','taskIds','executionId','parentExecutionId','framework','sourceKind','skill','skillVersion','agentName','ownership','status','anomaly','sort','dir','time','timeFrom','timeTo','summary','paginated','databasePagination','listPart','fields','lightweight','page','pageSize','includeEvaluations','skipAutoEvalReady','includeSubagents','onlySubagents','collapseGoalPlusWorkers','includeTags','tagIds','bizTag','userTagIds','userTagId','businessTagIds','filters','facet','column','kind','traceUser'];
function json(value:unknown,status=200) { return Response.json(value,{status,headers:{'cache-control':'no-store'}}); }
function failure(error:unknown) {
 const status=error instanceof Error && 'status' in error && typeof error.status==='number' ? error.status : 502;
 return json({error:status===401?'Authentication required':status===403?'Forbidden':status===503?'Storage compatibility configuration unavailable':'Storage request failed'},status);
}
async function mappedIdentity(request:Request,resolver?:CompatibilityOptions['resolveIdentity']):Promise<Binding> {
 const key=request.headers.get('x-witty-api-key');
 if(!key || key.length>1024)throw new CompatibilityError(401,'API credential required');
 const config=await identityMapping();
 const digest=createHash('sha256').update(key).digest('hex');
 const authenticated=resolver?await resolver(request):null;
 if(resolver&&(!authenticated?.username||authenticated.apiKey!==key))throw new CompatibilityError(401,'Invalid existing credential');
 const matches=config.bindings.filter(row=>(!authenticated||row.legacy_username===authenticated.username)&&row.legacy_api_key_sha256===digest);
 if(matches.length!==1)throw new CompatibilityError(403,'Identity has not been mapped');
 const binding=matches[0];
 if(!/^api_[A-Za-z0-9_-]{43}$/.test(binding.credential) || !binding.workspace_id || !binding.principal_id)throw new CompatibilityError(503,'Invalid mapping');
 return binding;
}
async function identityMapping() {
 const file=process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE;
 if(!file || !path.isAbsolute(file))throw new CompatibilityError(503,'Explicit identity mapping required');
 let config:{version:number;core_origin:string;bindings:Binding[]};
 try {
  const info=await lstat(file);if(!info.isFile() || info.isSymbolicLink() || (info.mode&0o077)!==0 || info.size>1024*1024)throw new Error('Invalid private mapping');
  config=JSON.parse(await readFile(file,'utf8'));
  if(config.version!==1 || config.core_origin!==coreServiceOrigin() || !Array.isArray(config.bindings) || config.bindings.length>1000)throw new Error('Invalid mapping');
 } catch { throw new CompatibilityError(503,'Invalid private mapping'); }
 return config;
}
export interface CoreBackgroundActor {token:string;workspace:string;principal:string;username:string;principalUsername:string}
const backgroundActorsKey=Symbol.for('agent-insight.storage-core.verified-background-actors');
const backgroundGlobals=globalThis as unknown as Record<symbol,WeakSet<object>>;
const verifiedBackgroundActors=backgroundGlobals[backgroundActorsKey] ||= new WeakSet<object>();
export function isVerifiedCoreBackgroundActor(value:unknown):value is CoreBackgroundActor{return !!value&&typeof value==='object'&&verifiedBackgroundActors.has(value);}
type UserBackgroundActor=CoreBackgroundActor & {user_record_id:string};
type BackgroundSource={origin:string;kind:'mapping'}|{origin:string;kind:'user';reference:Record<string,string>};
const backgroundSourcesKey=Symbol.for('agent-insight.storage-core.background-actor-sources');
const sourceGlobals=globalThis as unknown as Record<symbol,WeakMap<object,BackgroundSource>>;
const backgroundSources=sourceGlobals[backgroundSourcesKey] ||= new WeakMap<object,BackgroundSource>();
function brandBackgroundActor(actor:CoreBackgroundActor,source:BackgroundSource):CoreBackgroundActor{const verified=Object.freeze({...actor});verifiedBackgroundActors.add(verified);backgroundSources.set(verified,source);return verified;}
function backgroundOptions(options:CompatibilityOptions){
 const origin=coreServiceOrigin(),transport=options.fetcher||fetch;
 return {origin,options:{...options,fetcher:async(input:RequestInfo|URL,init?:RequestInit)=>{
  if(coreServiceOrigin()!==origin||new URL(input instanceof Request?input.url:String(input)).origin!==origin)throw new CompatibilityError(503,'Background storage origin changed');
  const result=await transport(input,init);if(coreServiceOrigin()!==origin){void result.body?.cancel();throw new CompatibilityError(503,'Background storage origin changed');}return result;
 }} satisfies CompatibilityOptions};
}
async function backgroundRpc(body:Record<string,string>,options:CompatibilityOptions):Promise<any>{
 const serialized=JSON.stringify(body);const headers=await controllerHeaders({principal:'platform-background',workspace:'platform-background'},serialized,'platform-control-bootstrap/v1');
 const {data}=await requestCore('/v1/compat/platform-control-bootstrap',{method:'POST',body:serialized,headers,responseLimit:4*1024*1024},options.fetcher||fetch);
 if(!data.value||typeof data.value!=='object'||Array.isArray(data.value))throw new CompatibilityError(502,'Invalid background credential response');return data.value;
}
function backgroundReference(actor:UserBackgroundActor):Record<string,string>{return {action:'background_actor',user_record_id:actor.user_record_id,principal_id:actor.principal,workspace_id:actor.workspace,username:actor.username,credential_sha256:createHash('sha256').update(actor.token).digest('hex')};}
function checkedBackgroundUser(value:unknown):UserBackgroundActor{
 const actor=value as UserBackgroundActor;
 if(!actor||typeof actor!=='object'||!/^api_[A-Za-z0-9_-]{43}$/.test(actor.token)||![actor.principal,actor.workspace,actor.username,actor.principalUsername,actor.user_record_id].every(item=>typeof item==='string'&&item.trim()&&item.length<=512&&!/[\u0000-\u001f\u007f-\u009f]/.test(item)))throw new CompatibilityError(503,'Invalid durable background user');return actor;
}
function validateBackgroundBindings(bindings:Binding[]){
 const declared=new Map<string,string>();
 for(const row of bindings){
  if(!row||!/^api_[A-Za-z0-9_-]{43}$/.test(row.credential)||!/^[a-f0-9]{64}$/.test(row.legacy_api_key_sha256)||![row.legacy_username,row.principal_id,row.workspace_id].every(value=>typeof value==='string'&&value.trim()&&value.length<=512&&!/[\u0000-\u001f\u007f-\u009f]/.test(value)))throw new CompatibilityError(503,'Invalid background identity mapping');
  const key=row.principal_id+'\0'+row.workspace_id;const prior=declared.get(key);if(prior&&prior!==row.legacy_username)throw new CompatibilityError(503,'Ambiguous background model owner');declared.set(key,row.legacy_username);
 }
 return declared;
}
export async function configuredCoreBackgroundActors(options:CompatibilityOptions={},allCredentials=false):Promise<{actors:CoreBackgroundActor[];failures:number[];ownerFailures:Map<string,number[]>}>{
 if(typeof window!=='undefined')throw new CompatibilityError(503,'Background identity is server only');
 const pinned=backgroundOptions(options);const bindings=process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE?(await identityMapping()).bindings:[];const declared=validateBackgroundBindings(bindings);
 const actors=new Map<string,CoreBackgroundActor>(),failures:number[]=[],ownerFailures=new Map<string,number[]>();
 const failed=(username:string,status:number)=>{const code=[401,403,503].includes(status)?status:503;const values=ownerFailures.get(username)||[];values.push(code);ownerFailures.set(username,values);};
 const keyOf=(actor:CoreBackgroundActor)=>actor.principal+'\0'+actor.workspace+'\0'+createHash('sha256').update(actor.token).digest('hex');
 for(const row of bindings){try{
  const actor=await context(new Request('http://localhost/internal/storage-background?'+new URLSearchParams({workspace_id:row.workspace_id}),{headers:{authorization:'Bearer '+row.credential}}),pinned.options);
  if(actor.principal!==row.principal_id||actor.workspace!==row.workspace_id||!actor.username||!actor.principalUsername)throw new CompatibilityError(403,'Background principal differs');
  const verified=brandBackgroundActor({...actor,username:row.legacy_username,principalUsername:actor.principalUsername},{kind:'mapping',origin:pinned.origin});actors.set(keyOf(verified),verified);
 }catch(error){const status=Number((error as {status?:number})?.status)||503;failures.push([401,403,503].includes(status)?status:503);failed(row.legacy_username,status);}}
 try{
  const restored=await backgroundRpc({action:'background_actors'},pinned.options);
  if(!Array.isArray(restored.actors)||!Array.isArray(restored.failures)||restored.actors.length>1000||restored.failures.some((value:unknown)=>![401,403,503].includes(Number(value))))throw new CompatibilityError(503,'Invalid durable background directory');
  failures.push(...restored.failures);
  if(restored.failure_owners!==undefined){if(!Array.isArray(restored.failure_owners)||restored.failure_owners.length>1000)throw new CompatibilityError(503,'Invalid background source failures');for(const row of restored.failure_owners){if(!row||![row.username,row.principal,row.workspace].every(value=>typeof value==='string'&&value.trim()&&value.length<=512)||![401,403,503].includes(row.status))throw new CompatibilityError(503,'Invalid background source failure');failed(declared.get(row.principal+'\0'+row.workspace)||row.username,row.status);}}
  const names=new Map<string,Set<string>>();for(const value of restored.actors){const row=checkedBackgroundUser(value),key=row.principal+'\0'+row.workspace;const labels=names.get(key)||new Set<string>();labels.add(row.username);names.set(key,labels);}
  for(const value of restored.actors){try{
   const row=checkedBackgroundUser(value),scope=row.principal+'\0'+row.workspace;if(names.get(scope)!.size!==1)throw new CompatibilityError(403,'Ambiguous durable background owner');
   const actor=await context(new Request('http://localhost/internal/storage-background?'+new URLSearchParams({workspace_id:row.workspace}),{headers:{authorization:'Bearer '+row.token}}),pinned.options);
   if(actor.principal!==row.principal||actor.workspace!==row.workspace||actor.principalUsername!==row.principalUsername)throw new CompatibilityError(403,'Durable background principal differs');
   if(actors.has(keyOf(row)))continue;
   const verified=brandBackgroundActor({token:row.token,principal:row.principal,workspace:row.workspace,principalUsername:row.principalUsername,username:declared.get(scope)||row.username},{kind:'user',origin:pinned.origin,reference:backgroundReference(row)});actors.set(keyOf(verified),verified);
  }catch(error){const status=Number((error as {status?:number})?.status)||503;failures.push([401,403,503].includes(status)?status:503);const row=value as Partial<UserBackgroundActor>;if(typeof row?.username==='string')failed(declared.get(row.principal+'\0'+row.workspace)||row.username,status);}}
 }catch(error){const status=Number((error as {status?:number})?.status)||503;failures.push([401,403,503].includes(status)?status:503);if(!actors.size&&status!==401&&status!==403)throw error;}
 if(allCredentials)return {actors:[...actors.values()],failures,ownerFailures};
 const scopes=new Map<string,CoreBackgroundActor>();for(const actor of actors.values())scopes.set(actor.principal+'\0'+actor.workspace,actor);return {actors:[...scopes.values()],failures,ownerFailures};
}

async function context(request:Request,options:CompatibilityOptions={}) {
 const header=request.headers.get('authorization');
 let token:string;let workspace:string|undefined;let principal:string|undefined;let modelUsername:string|undefined;
 if(header!==null) {
  const match=/^Bearer (.+)$/.exec(header);
  if(!match || !IAM_TOKEN.test(match[1]))throw new CompatibilityError(401,'Invalid bearer');
  token=match[1];
 } else if(IAM_TOKEN.test(request.headers.get('x-witty-api-key') || ''))token=request.headers.get('x-witty-api-key')!;
 else { const binding=await mappedIdentity(request,options.resolveIdentity);token=binding.credential;workspace=binding.workspace_id;principal=binding.principal_id;modelUsername=binding.legacy_username; }
 const {data:profile}=await requestCore('/v1/auth/me',{token},options.fetcher || fetch);
 if(typeof profile.principal_id!=='string' || !Array.isArray(profile.workspaces) || (principal && profile.principal_id!==principal))throw new CompatibilityError(403,'Mapped principal mismatch');
 const requested=new URL(request.url).searchParams.get('workspace_id');
 if(workspace && requested && requested!==workspace)throw new CompatibilityError(403,'Mapped workspace mismatch');
 workspace=workspace || requested || (typeof profile.workspace_id==='string'?profile.workspace_id:undefined);
 if(!workspace || !profile.workspaces.some((row:unknown)=>!!row && typeof row==='object' && 'workspace_id' in row && row.workspace_id===workspace))throw new CompatibilityError(403,'Workspace not granted');
 if(!modelUsername&&typeof profile.legacy_username!=='string'&&process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE){const aliases=new Set((await identityMapping()).bindings.filter(row=>row.principal_id===profile.principal_id&&row.workspace_id===workspace).map(row=>row.legacy_username));if(aliases.size>1)throw new CompatibilityError(503,'Ambiguous control owner alias');modelUsername=[...aliases][0];}
 return {token,workspace,principal:profile.principal_id,username:modelUsername || (typeof profile.legacy_username==='string'?profile.legacy_username:typeof profile.username==='string'?profile.username:null),principalUsername:typeof profile.username==='string'?profile.username:null};
}
export async function compatibleRequest(request:Request,target:string,fields:string[],options:CompatibilityOptions={}) {
 try {
  const actor=await context(request,options);const source=new URL(request.url).searchParams;const query=new URLSearchParams({workspace_id:actor.workspace});
  for(const key of fields) {const values=source.getAll(key);if(values.length>1)throw new CompatibilityError(400,'Duplicate query parameter');if(values.length)query.set(key,values[0]);}
  let body:string|undefined;
  if(request.method!=='GET' && request.method!=='HEAD') {
   const raw=await readCoreBytes(request.body,target.endsWith('/traces/import') ? 50*1024*1024 : 4*1024*1024);
   if(raw.length || request.method!=='DELETE') {
    try {body=new TextDecoder('utf-8',{fatal:true}).decode(raw);JSON.parse(body);}catch{throw new CompatibilityError(400,'Invalid JSON');}
   }
  }
  const transfer=target.includes('/traces/');
  const responseLimit=target.endsWith('/session') || transfer ? 128*1024*1024 : 4*1024*1024;
  const timeoutMs=transfer || (target.endsWith('/session') && source.get('view')!=='structure') ? 300_000 : 15_000;
  const headers:Record<string,string>={};
  const receipt=request.headers.get('idempotency-key');
  if(target.endsWith('/traces/import') && receipt!==null) {
   if(!/^[\x21-\x7e]{1,512}$/.test(receipt))throw new CompatibilityError(400,'Invalid import receipt');
   headers['idempotency-key']=receipt;
  }
  const {data,status}=await requestCore(target+'?'+query,{token:actor.token,method:request.method,body,responseLimit,timeoutMs,headers},options.fetcher || fetch);
  if(!Object.prototype.hasOwnProperty.call(data,'value'))throw new CompatibilityError(502,'Invalid compatibility response');
  const result=json(data.value,status);
  if(target.endsWith('/traces/export')) {
   const value=data.value as {rootExecutionId?:unknown};
   if(typeof value?.rootExecutionId!=='string')throw new CompatibilityError(502,'Invalid export response');
   const name=value.rootExecutionId.replace(/[^A-Za-z0-9._-]+/g,'_').slice(0,120) || 'trace';
   result.headers.set('content-disposition',`attachment; filename="trace-${name}.json"`);
  }
  if(status>=200&&status<300&&actor.username){
   let feature:string|undefined,event:string|undefined;
   if(target==='/v1/compat/observe/data'&&request.method==='DELETE'&&Number((data.value as Record<string,unknown>)?.count)>0){feature='trace';event='trace.delete';}
   else if(target==='/v1/compat/observe/data'&&request.method==='PATCH'){feature='trace';event='trace.update';}
   else if(target==='/v1/compat/observe/traces/import'){feature='trace';event='trace.import';}
   else if(target==='/v1/compat/observe/traces/export'){feature='trace';event='trace.export';}
   else if(/^\/v1\/compat\/executions\/[^/]+\/tags$/.test(target)&&['POST','PUT','DELETE'].includes(request.method)){feature='trace';event=request.method==='DELETE'?'trace.tag.unbind':'trace.tag.bind';}
   else if(/^\/v1\/compat\/tags(?:\/[^/]+)?$/.test(target)&&['POST','PUT','DELETE'].includes(request.method)){feature='version-management';event=request.method==='POST'?'version.tag.create':request.method==='DELETE'?'version.tag.delete':'version.tag.update';}
   if(feature&&event)recordVerifiedCoreUsage({...actor,username:actor.username},options,feature,event);
  }
  return result;
 } catch(error) {return failure(error);}
}
export async function handleCompatibleObserveData(request:Request,options:CompatibilityOptions={}) {
 if(request.method==='PATCH'){
  try{
   const raw=await readCoreBytes(request.clone().body,4*1024*1024);
   let value:Record<string,unknown>;
   try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)) as Record<string,unknown>;}catch{throw new CompatibilityError(400,'Invalid JSON');}
   if(value&&typeof value==='object'&&!Array.isArray(value)){
    const key=Object.hasOwn(value,'user_feedback')?'user_feedback':Object.hasOwn(value,'label')?'label':typeof value.query==='string'?'query':typeof value.final_result==='string'?'final_result':null;
    if(key==='final_result'){const {handleCoreFinalResultEdit}=await import('./trace-outcome');return handleCoreFinalResultEdit(request,options);}
    if(key==='query'){const {handleCoreQueryEdit}=await import('./trace-outcome');return handleCoreQueryEdit(request,options);}
   }
  }catch(error){return failure(error instanceof SyntaxError?new CompatibilityError(400,'Invalid JSON'):error);}
 }
 return compatibleRequest(request,'/v1/compat/observe/data',DATA_FIELDS,options);
}
export function handleCompatibleSession(request:Request,options:CompatibilityOptions={}) {
 return compatibleRequest(request,'/v1/compat/observe/session',['taskId','view','index','source'],options);
}

export async function handleCompatibleIngest(request:Request,options:CompatibilityOptions={}) {
 try {
  const actor=await context(request,options);
  if(!actor.token.startsWith('api_'))throw new CompatibilityError(403,'Collector API credential required');
  const headers=new Headers(request.headers);headers.set('authorization','Bearer '+actor.token);headers.set('x-workspace-id',actor.workspace);headers.delete('x-witty-api-key');
  return await handleCoreIngest(new Request(request.url,{method:request.method,headers,body:request.body,duplex:'half'} as RequestInit & {duplex:'half'}),options.fetcher || fetch);
 }catch(error){return failure(error);}
}

export function handleCompatibleTags(request:Request,tagID?:string,options:CompatibilityOptions={}) {
 return compatibleRequest(request,'/v1/compat/tags'+(tagID?'/'+encodeURIComponent(tagID):''),['kind'],options);
}
export function handleCompatibleTraceTags(request:Request,executionID:string,options:CompatibilityOptions={}) {
 return compatibleRequest(request,'/v1/compat/executions/'+encodeURIComponent(executionID)+'/tags',['tagId'],options);
}

export function handleCompatibleTransfer(request:Request,direction:'import'|'export',options:CompatibilityOptions={}) {
 return compatibleRequest(request,'/v1/compat/observe/traces/'+direction,['executionId'],options);
}

export { context as compatibilityContext, failure as compatibilityFailure };

export async function configuredCoreBackgroundActorForUser(username:string,options:CompatibilityOptions={}):Promise<CoreBackgroundActor>{
 if(typeof window!=='undefined')throw new CompatibilityError(503,'Background identity is server only');
 const {actors,ownerFailures}=await configuredCoreBackgroundActors(options,true);const candidates=actors.filter(actor=>actor.username===username),scopes=new Set(candidates.map(actor=>actor.principal+'\0'+actor.workspace));
 if(!scopes.size){const failures=ownerFailures.get(username)||[];if(failures.includes(503))throw new CompatibilityError(503,'Background owner credential unavailable');if(failures.includes(401))throw new CompatibilityError(401,'Background owner credential invalid');}
 if(scopes.size!==1)throw new CompatibilityError(403,'Background owner requires one verified principal and workspace');
 if(candidates.length>16)throw new CompatibilityError(503,'Background owner exceeds credential budget');
 return candidates.find(actor=>backgroundSources.get(actor)?.kind==='user')||candidates[0];
}

export async function coreCollectorModelUsername(actor:{principal:string;workspace:string;username:string|null}):Promise<string|null>{
 if(!process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE)return actor.username;
 const config=await identityMapping();const matches=config.bindings.filter(row=>row.principal_id===actor.principal&&row.workspace_id===actor.workspace);
 const names=new Set(matches.map(row=>row.legacy_username));if(names.size>1)throw new CompatibilityError(403,'Collector owner mapping is ambiguous');
 return names.size===1?[...names][0]:actor.username;
}

export async function revalidateConfiguredCoreBackgroundActor(actor:CoreBackgroundActor,options:CompatibilityOptions={}){
 if(!isVerifiedCoreBackgroundActor(actor))throw new CompatibilityError(403,'Verified background actor required');
 const source=backgroundSources.get(actor),pinned=backgroundOptions(options);if(!source||source.origin!==pinned.origin)throw new CompatibilityError(403,'Background actor origin changed');
 if(source.kind==='mapping'){
  const config=await identityMapping();validateBackgroundBindings(config.bindings);const rows=config.bindings.filter(row=>row.legacy_username===actor.username);
  if(!rows.some(row=>row.principal_id===actor.principal&&row.workspace_id===actor.workspace&&row.credential===actor.token)||rows.some(row=>row.principal_id!==actor.principal||row.workspace_id!==actor.workspace))throw new CompatibilityError(403,'Background actor mapping changed');
 }else{
  const row=checkedBackgroundUser(await backgroundRpc(source.reference,pinned.options));
  if(row.token!==actor.token||row.principal!==actor.principal||row.workspace!==actor.workspace||row.principalUsername!==actor.principalUsername||await coreCollectorModelUsername(row)!==actor.username)throw new CompatibilityError(403,'Durable background owner changed');
 }
 const current=await context(new Request('http://localhost/internal/storage-background?'+new URLSearchParams({workspace_id:actor.workspace}),{headers:{authorization:'Bearer '+actor.token}}),pinned.options);
 if(current.principal!==actor.principal||current.workspace!==actor.workspace||current.principalUsername!==actor.principalUsername)throw new CompatibilityError(403,'Background actor scope changed');
}

export async function verifiedCoreLoginBinding(username:string){
 if(!process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE)return null;
 const config=await identityMapping();const rows=config.bindings.filter(row=>row.legacy_username===username);if(!rows.length)return null;
 const scopes=new Set(rows.map(row=>row.principal_id+'\0'+row.workspace_id+'\0'+row.credential));if(scopes.size!==1)throw new CompatibilityError(503,'Ambiguous legacy login binding');
 const row=rows[0];const actor=await context(new Request('http://localhost/internal/control-login?'+new URLSearchParams({workspace_id:row.workspace_id}),{headers:{authorization:'Bearer '+row.credential}}));
 if(actor.principal!==row.principal_id||actor.workspace!==row.workspace_id||actor.username!==username)throw new CompatibilityError(403,'Legacy login owner differs');return actor;
}
