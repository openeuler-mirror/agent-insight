import {AsyncLocalStorage} from 'node:async_hooks';
import {compatibilityContext,coreCollectorModelUsername,configuredCoreBackgroundActorForUser,revalidateConfiguredCoreBackgroundActor,isVerifiedCoreBackgroundActor,type CompatibilityOptions,type CoreBackgroundActor} from './compat';
import {coreServiceOrigin,requestCore} from './server';

type CollectorOperation='snapshot'|'complete';
export interface CollectorIdentityInput {
 operation:CollectorOperation;
 framework?:string;
 clientId?:string|null;
 authorizationKind?:'collector'|'provider';
}
export interface CoreCollectorIdentity {
 readonly principal:string;readonly workspace:string;readonly username:string;readonly principalUsername:string;
 readonly operation:CollectorOperation;readonly clientId?:string;readonly authentication:'api-key'|'device-credential';
 revalidate():Promise<void>;
}
interface Actor {token:string;principal:string;workspace:string;username:string;principalUsername:string}
interface Resolution {actor:Actor;clientId?:string;authentication:CoreCollectorIdentity['authentication']}
const activeCollectorKey=Symbol.for('agent-insight.storage-core.collector-identity-scope');
const activeCollectorGlobals=globalThis as unknown as Record<symbol,AsyncLocalStorage<CoreCollectorIdentity>>;
const activeCollectors=activeCollectorGlobals[activeCollectorKey] ||= new AsyncLocalStorage<CoreCollectorIdentity>();
export const getActiveCoreCollectorIdentity=()=>activeCollectors.getStore();
const identities=new WeakMap<CoreCollectorIdentity,{refresh:()=>Promise<Resolution>;current:Resolution;options:Readonly<CompatibilityOptions>}>();
const failure=(status:number,message:string)=>Object.assign(new Error(message),{status});
const apiToken=/^api_[A-Za-z0-9_-]{43}$/;
const iamBearer=/^Bearer ((?:api|session)_[A-Za-z0-9_-]{43})$/i;
const statusOf=(error:unknown)=>error&&typeof error==='object'&&'status'in error?Number(error.status):undefined;

function normalizedRequest(request:Request):Request {
 const url=new URL(request.url),workspaces=url.searchParams.getAll('workspace_id'),header=request.headers.get('x-workspace-id');
 if(workspaces.length>1)throw failure(400,'Duplicate collector workspace');
 if(header&&workspaces.length&&header!==workspaces[0])throw failure(403,'Collector workspace differs');
 if(header)url.searchParams.set('workspace_id',header);
 return new Request(url,{headers:request.headers});
}
async function writable(actor:Actor,operation:CollectorOperation,options:CompatibilityOptions):Promise<void>{
 const {data}=await requestCore('/v1/compat/collector-source?'+new URLSearchParams({workspace_id:actor.workspace}),{token:actor.token,method:'POST',body:JSON.stringify({action:'scope',operation}),responseLimit:4096},options.fetcher||fetch);
 const value=data.value as Record<string,unknown>|undefined;
 if(!value||value.authorized!==true||value.operation!==operation||value.principal_id!==actor.principal||value.workspace_id!==actor.workspace)throw failure(403,'Collector capability scope differs');
}
async function direct(request:Request,options:CompatibilityOptions):Promise<Actor>{
 const value=await compatibilityContext(request,options);
 if(!apiToken.test(value.token))throw failure(403,'Collector API credential required');
 if(!value.username||!value.principalUsername)throw failure(403,'Collector owner is unavailable');
 const username=await coreCollectorModelUsername(value);
 return {...value,username:username||value.username,principalUsername:value.principalUsername};
}
async function resolve(request:Request,input:CollectorIdentityInput,options:CompatibilityOptions):Promise<Resolution>{
 const directActors:Actor[]=[];let invalid:unknown;const key=request.headers.get('x-witty-api-key');
 const authorization=input.authorizationKind==='provider'?null:request.headers.get('authorization');
 const bearer=authorization?.match(iamBearer);
 const headers=new Headers();
 if(key){headers.set('x-witty-api-key',key);try{directActors.push(await direct(new Request(request.url,{headers}),options));}catch(error){if(statusOf(error)!==401)throw error;invalid=error;}}
 if(bearer){try{directActors.push(await direct(new Request(request.url,{headers:{authorization:'Bearer '+bearer[1]}}),options));}catch(error){if(statusOf(error)!==401)throw error;invalid=error;}}
 if(directActors.some(actor=>actor.principal!==directActors[0].principal||actor.workspace!==directActors[0].workspace))throw failure(403,'Collector API credentials identify different scopes');
 let device:{clientId:string;user:string}|undefined;
 if(input.authorizationKind!=='provider'&&input.framework?.toLowerCase()==='opencode'&&(request.headers.has('x-agent-insight-client-id')||/^Bearer\s+dc_/i.test(authorization?.trim()||''))){
  try{const {authenticateDevice}=await import('@/lib/reliability/client-registry');device=await authenticateDevice(request);}
  catch(error){if(![401,403,404].includes(statusOf(error)||0))throw error;invalid=error;}
 }
 let deviceActor:CoreBackgroundActor|undefined;
 if(device){
  if(input.clientId&&input.clientId!==device.clientId)throw failure(403,'Reported client does not match verified device');
  deviceActor=await configuredCoreBackgroundActorForUser(device.user,options);
  if(!isVerifiedCoreBackgroundActor(deviceActor))throw failure(403,'Verified device owner mapping required');
  const workspace=new URL(request.url).searchParams.get('workspace_id');
  if(workspace&&workspace!==deviceActor.workspace)throw failure(403,'Device workspace differs');
  if(directActors.some(actor=>actor.principal!==deviceActor!.principal||actor.workspace!==deviceActor!.workspace))throw failure(403,'API credential and device owner differ');
 }
 const actor=directActors[0]||deviceActor;
 if(!actor)throw failure(statusOf(invalid)===403?403:401,'Collector authentication required');
 for(const candidate of directActors)await writable(candidate,input.operation,options);
 if(deviceActor&&!directActors.some(candidate=>candidate.token===deviceActor!.token))await writable(deviceActor,input.operation,options);
 return {actor:deviceActor?{...actor,username:deviceActor.username}:actor,...(device?{clientId:device.clientId}:{}),authentication:directActors.length?'api-key':'device-credential'};
}
function same(a:Resolution,b:Resolution):boolean{
 return a.actor.principal===b.actor.principal&&a.actor.workspace===b.actor.workspace&&a.actor.username===b.actor.username&&a.actor.principalUsername===b.actor.principalUsername&&a.clientId===b.clientId&&a.authentication===b.authentication;
}
export function isVerifiedCoreCollectorIdentity(value:unknown):value is CoreCollectorIdentity{return !!value&&typeof value==='object'&&identities.has(value as CoreCollectorIdentity);}
export async function resolveCoreCollectorIdentity(request:Request,input:CollectorIdentityInput,options:CompatibilityOptions={}):Promise<CoreCollectorIdentity>{
 if(typeof window!=='undefined')throw failure(503,'Collector identity is server only');
 if(!input||!['snapshot','complete'].includes(input.operation)||input.authorizationKind!==undefined&&!['collector','provider'].includes(input.authorizationKind))throw failure(400,'Invalid collector operation');
 const origin=coreServiceOrigin(),transport=options.fetcher||fetch;
 const pinned:CompatibilityOptions={...options,fetcher:async(url,init)=>{
  if(coreServiceOrigin()!==origin||new URL(url instanceof Request?url.url:String(url)).origin!==origin)throw failure(503,'Collector storage origin changed');
  const response=await transport(url,init);
  if(coreServiceOrigin()!==origin){void response.body?.cancel();throw failure(503,'Collector storage origin changed');}
  return response;
 }};
 const normalized=normalizedRequest(request),selection=Object.freeze({...input}),initial=await resolve(normalized,selection,pinned);
 const state={current:initial,options:Object.freeze(pinned),refresh:async()=>{if(coreServiceOrigin()!==origin)throw failure(503,'Collector storage origin changed');return resolve(normalized,selection,pinned);}};
 const identity=Object.freeze({principal:initial.actor.principal,workspace:initial.actor.workspace,username:initial.actor.username,principalUsername:initial.actor.principalUsername,operation:selection.operation,...(initial.clientId?{clientId:initial.clientId}:{}),authentication:initial.authentication,revalidate:async()=>{const current=await state.refresh();if(!same(initial,current))throw failure(403,'Collector identity changed');state.current=current;}});
 identities.set(identity,state);return identity;
}
export async function withCoreCollectorIdentity<T>(identity:CoreCollectorIdentity,action:(actor:Readonly<Actor>,options:Readonly<CompatibilityOptions>)=>Promise<T>):Promise<T>{
 const state=identities.get(identity);if(!state)throw failure(403,'Verified collector identity required');
 await identity.revalidate();return activeCollectors.run(identity,()=>action(Object.freeze({...state.current.actor}),state.options));
}

export function collectorIdentityForOperation(identity:CoreCollectorIdentity,operation:CollectorOperation):CoreCollectorIdentity{
 const state=identities.get(identity);if(!state||!['snapshot','complete'].includes(operation))throw failure(403,'Verified collector identity required');
 if(identity.operation===operation)return identity;
 const selected=Object.freeze({...identity,operation});identities.set(selected,state);return selected;
}
export async function collectorIdentityForBackgroundActor(actor:CoreBackgroundActor,input:CollectorIdentityInput,options:CompatibilityOptions={}):Promise<CoreCollectorIdentity>{
 if(!isVerifiedCoreBackgroundActor(actor))throw failure(403,'Verified collector background actor required');
 const request=new Request('http://localhost/internal/collector?'+new URLSearchParams({workspace_id:actor.workspace}),{headers:{authorization:'Bearer '+actor.token}});
 const original=await resolveCoreCollectorIdentity(request,input,options);const state=identities.get(original)!;
 const selected=Object.freeze({...original,username:actor.username,revalidate:async()=>{
  await original.revalidate();await revalidateConfiguredCoreBackgroundActor(actor,options);
  state.current={...state.current,actor:{...state.current.actor,username:actor.username}};
 }});identities.set(selected,state);await selected.revalidate();return selected;
}
