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
 const authenticated=await (resolver || (async (input:Request)=>(await import('@/lib/auth/auth')).resolveUser(input)))(request);
 if(!authenticated.username || authenticated.apiKey!==key)throw new CompatibilityError(401,'Invalid existing credential');
 const config=await identityMapping();
 const digest=createHash('sha256').update(key).digest('hex');
 const matches=config.bindings.filter(row=>row.legacy_username===authenticated.username && row.legacy_api_key_sha256===digest);
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
export async function configuredCoreBackgroundActors(options:CompatibilityOptions={}):Promise<{actors:CoreBackgroundActor[];failures:number[]}>{
 if(typeof window!=='undefined')throw new CompatibilityError(503,'Background identity is server only');
 const config=await identityMapping();const declared=new Map<string,string>();
 for(const row of config.bindings){
  if(!row||!/^api_[A-Za-z0-9_-]{43}$/.test(row.credential)||![row.legacy_username,row.principal_id,row.workspace_id].every(value=>typeof value==='string'&&value.trim()&&value.length<=512&&!/[\u0000-\u001f\u007f-\u009f]/.test(value)))throw new CompatibilityError(503,'Invalid background identity mapping');
  const key=row.principal_id+'\0'+row.workspace_id;const prior=declared.get(key);if(prior&&prior!==row.legacy_username)throw new CompatibilityError(503,'Ambiguous background model owner');declared.set(key,row.legacy_username);
 }
 const actors=new Map<string,CoreBackgroundActor>();const failures:number[]=[];
 for(const row of config.bindings){
  try{
   const request=new Request('http://localhost/internal/storage-background?'+new URLSearchParams({workspace_id:row.workspace_id}),{headers:{authorization:'Bearer '+row.credential}});
   const actor=await context(request,options);
   if(actor.principal!==row.principal_id||actor.workspace!==row.workspace_id||!actor.username)throw new CompatibilityError(403,'Background principal differs');
   const verified=Object.freeze({...actor,username:row.legacy_username,principalUsername:actor.principalUsername || actor.username});verifiedBackgroundActors.add(verified);
   actors.set(actor.principal+'\0'+actor.workspace,verified);
  }catch(error){const status=error&&typeof error==='object'&&'status'in error?Number(error.status):503;failures.push([401,403,503].includes(status)?status:503);}
 }
 return {actors:[...actors.values()],failures};
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
 return {token,workspace,principal:profile.principal_id,username:modelUsername || (typeof profile.username==='string'?profile.username:null),principalUsername:typeof profile.username==='string'?profile.username:null};
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
  return result;
 } catch(error) {return failure(error);}
}
export function handleCompatibleObserveData(request:Request,options:CompatibilityOptions={}) {
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
