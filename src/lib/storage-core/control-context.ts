import {AsyncLocalStorage} from 'node:async_hooks';
import {compatibilityContext,isVerifiedCoreBackgroundActor,type CompatibilityOptions,type CoreBackgroundActor} from './compat';
import {coreServiceOrigin} from './server';
export interface CoreControlActor {token:string;workspace:string;principal:string;username:string;principalUsername?:string|null}
export interface CoreControlContext {actor:Readonly<CoreControlActor>;options:Readonly<CompatibilityOptions>;origin:string;access:'request'|'collector-preparation';request?:Request;device?:{credentialHash:string;clientId:string};install?:{tokenHash:string;previousCredentialHash?:string};bootstrap?:true;capabilities?:readonly string[];skillDirectories?:Map<string,string>}
const key=Symbol.for('agent-insight.storage-core.control-context');
const globalContexts=globalThis as unknown as Record<symbol,AsyncLocalStorage<CoreControlContext>>;
const contexts=globalContexts[key] ||= new AsyncLocalStorage<CoreControlContext>();
const failure=(status:number,message:string)=>Object.assign(new Error(message),{status});
export const getCoreControlContext=()=>contexts.getStore();
export function requireCoreControlContext():CoreControlContext {const context=contexts.getStore();if(!context)throw failure(503,'Trusted control repository scope required');if(context.origin!==coreServiceOrigin())throw failure(503,'Control storage origin changed');return context;}
export function runWithCoreControlActor<T>(actor:CoreControlActor,options:CompatibilityOptions,action:()=>T,access:CoreControlContext['access']='request'):T {
 if(!actor?.token||!actor.username||!actor.principal||!actor.workspace)throw failure(403,'Verified control actor required');
 const prior=contexts.getStore(),origin=coreServiceOrigin();
 const capabilities=access==='request'&&prior?.access==='request'&&prior.origin===origin&&prior.actor.token===actor.token&&prior.actor.principal===actor.principal&&prior.actor.workspace===actor.workspace?prior.capabilities:undefined;
 return contexts.run({actor:Object.freeze({...actor}),options:Object.freeze({...options}),origin,access,...(capabilities?{capabilities}:{})},action);
}
export async function withCoreControlRequest<T>(request:Request,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 const origin=coreServiceOrigin(),transport=options.fetcher||fetch;
 const pinned:CompatibilityOptions={...options,fetcher:async(input,init)=>{if(coreServiceOrigin()!==origin||new URL(input instanceof Request?input.url:String(input)).origin!==origin)throw failure(503,'Control storage origin changed');const result=await transport(input,init);if(coreServiceOrigin()!==origin){void result.body?.cancel();throw failure(503,'Control storage origin changed');}return result;}};
 const actor=await compatibilityContext(request,pinned);if(!actor.username)throw failure(403,'Verified control owner required');
 if(coreServiceOrigin()!==origin)throw failure(503,'Control storage origin changed');
 return runWithCoreControlActor({...actor,username:actor.username},pinned,()=>{requireCoreControlContext().request=request;return action();});
}
export async function withVerifiedCoreControlActor<T>(actor:CoreBackgroundActor,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 if(!isVerifiedCoreBackgroundActor(actor))throw failure(403,'Verified background control actor required');
 await (await import('./compat')).revalidateConfiguredCoreBackgroundActor(actor,options);
 const request=new Request('http://localhost/internal/control?'+new URLSearchParams({workspace_id:actor.workspace}),{headers:{authorization:'Bearer '+actor.token}});
 return withCoreControlRequest(request,async()=>{const current=requireCoreControlContext().actor;
  if(current.principal!==actor.principal||current.workspace!==actor.workspace||current.token!==actor.token||current.principalUsername!==actor.principalUsername)throw failure(403,'Background control actor changed');
  requireCoreControlContext().actor=Object.freeze({...current,username:actor.username});return action();
 },options);
}

export function runWithCoreControlCapability<T>(actor:CoreControlActor,capability:{device?:CoreControlContext['device'];install?:CoreControlContext['install']},action:()=>T):T{
 return runWithCoreControlActor(actor,{},()=>{Object.assign(requireCoreControlContext(),capability);return action();});
}
