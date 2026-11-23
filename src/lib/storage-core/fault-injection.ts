import {createHash,randomUUID} from 'node:crypto';
import type {FaultInjectionTask,FaultInjectionRun,FaultInjectionWorker} from '@prisma/client';
import {isStorageCoreEnabled} from './mode';
import {compatibilityFailure,type CompatibilityOptions} from './compat';
import {coreCookieName,coreServiceOrigin,requestCore} from './server';
import {controllerHeaders} from './controller';
import {getCoreControlContext,requireCoreControlContext,runWithCoreControlActor,withCoreControlRequest} from './control-context';
import {getCoreExperimentContext} from './experiments';

const fail=(message:string,status=503)=>Object.assign(new Error(message),{status});
function requestIdentity(request:Request):Request {
 const url=new URL(request.url),workspaces=url.searchParams.getAll('workspace_id'),workspace=request.headers.get('x-workspace-id');
 if(workspaces.length>1)throw fail('Duplicate FI workspace',400);
 if(workspace&&workspaces.length&&workspace!==workspaces[0])throw fail('FI workspace differs',403);
 if(workspace)url.searchParams.set('workspace_id',workspace);
 if(url.href!==request.url)request=new Request(url,{headers:request.headers});
 if(request.headers.has('authorization')||request.headers.has('x-witty-api-key'))return request;
 const name=coreCookieName()+'=',matches=(request.headers.get('cookie')||'').split(';').map(value=>value.trim()).filter(value=>value.startsWith(name));
 if(matches.length!==1)return request;
 const headers=new Headers(request.headers);headers.set('authorization','Bearer '+matches[0].slice(name.length));return new Request(request,{headers});
}
export async function withCoreFiRequest(request:Request,action:()=>Promise<Response>,options:CompatibilityOptions={}):Promise<Response>{

 try {
  const origin=coreServiceOrigin(),transport=options.fetcher||fetch;
  const fetcher:typeof fetch=async(input,init)=>{if(coreServiceOrigin()!==origin||new URL(input instanceof Request?input.url:String(input)).origin!==origin)throw fail('FI storage origin changed');const response=await transport(input,init);if(coreServiceOrigin()!==origin){void response.body?.cancel();throw fail('FI storage origin changed');}return response;};
  const bearer=request.headers.get('authorization')?.match(/^Bearer (dc_[A-Za-z0-9_-]+)$/);
  if(bearer){
   const credentialHash=createHash('sha256').update(bearer[1]).digest('hex');
   const body=JSON.stringify({action:'identity',payload:{},capability:{type:'device',credential_hash:credentialHash}});
   const headers=await controllerHeaders({principal:'device:'+credentialHash,workspace:'device'},body,'fault-injection/v1');
   const {data}=await requestCore('/v1/compat/fault-injection',{method:'POST',body,headers},fetcher);
   const value=data.value as {principal:string;workspace:string;username:string;client_id:string};
   if(!value?.principal||!value.workspace||!value.username||!value.client_id)throw fail('FI device identity unavailable',403);
   const clientId=request.headers.get('x-agent-insight-client-id');if(clientId&&clientId!==value.client_id)throw fail('FI device client differs',403);
   const workspaces=new URL(request.url).searchParams.getAll('workspace_id'),workspace=request.headers.get('x-workspace-id');if(workspaces.length>1)throw fail('Duplicate FI workspace',400);if((workspaces[0]&&workspaces[0]!==value.workspace)||(workspace&&workspace!==value.workspace))throw fail('FI device workspace differs',403);
   return await runWithCoreControlActor({token:'internal-fi-device',principal:value.principal,workspace:value.workspace,username:value.username},{...options,fetcher},()=>{const context=requireCoreControlContext();context.device={credentialHash,clientId:value.client_id};context.request=request;return action();});
  }
  return await withCoreControlRequest(requestIdentity(request),action,{...options,fetcher});
 }catch(error){return compatibilityFailure(error);}
}
export async function coreFiRpc<T>(action:string,payload:Record<string,unknown>={}):Promise<T>{
 const control=getCoreControlContext(),experiment=getCoreExperimentContext();
 if(control&&experiment&&(control.actor.principal!==experiment.actor.principal||control.actor.workspace!==experiment.actor.workspace||control.actor.username!==experiment.actor.username))throw fail('FI control and experiment actors differ',403);
 const actor=control?.actor||experiment?.actor,options=control?.options||experiment?.options||{};
 if(!actor||!actor.username)throw fail('Trusted FI owner scope required',403);
 if(control&&control.origin!==coreServiceOrigin())throw fail('FI storage origin changed');
 const device=control?.device;
 const body=JSON.stringify({action,payload,username:actor.username,...(device?{capability:{type:'device',credential_hash:device.credentialHash,client_id:device.clientId}}:{})});
 const headers=await controllerHeaders({principal:device?'device:'+device.credentialHash:actor.principal,workspace:actor.workspace},body,'fault-injection/v1');
 const {data}=await requestCore('/v1/compat/fault-injection?'+new URLSearchParams({workspace_id:actor.workspace}),{token:device?undefined:actor.token,method:'POST',body,headers,responseLimit:16*1024*1024},options.fetcher||fetch);
 if(control&&control.origin!==coreServiceOrigin())throw fail('FI storage origin changed');
 if(!data.value||typeof data.value!=='object')throw fail('FI storage response unavailable');
 return hydrate(data.value) as T;
}
function hydrate(value:unknown):unknown {
 if(Array.isArray(value))return value.map(hydrate);
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,item!==null&&typeof item==='string'&&/^(createdAt|updatedAt|startedAt|finishedAt|queuedAt|claimedAt|lastSeenAt|faultActivatedAt|judgedAt)$/.test(key)?new Date(item):hydrate(item)]));
}
export function coreFiOwner(expected?:string|null):string {
 const actor=getCoreControlContext()?.actor||getCoreExperimentContext()?.actor;
 if(!actor?.username||expected&&expected!==actor.username)throw fail('FI owner differs',403);return actor.username;
}
export async function listCoreFiTasks(input:{taskIds?:string[];status?:string|null;includeRuns?:boolean}={}):Promise<Array<FaultInjectionTask&{runs:FaultInjectionRun[]}>>{return(await coreFiRpc<{tasks:Array<FaultInjectionTask&{runs:FaultInjectionRun[]}>}>('read_tasks',input)).tasks;}
export async function findCoreFiTask(taskKey:string,includeRuns=false){return(await listCoreFiTasks({taskIds:[taskKey],includeRuns}))[0]||null;}
export async function findCoreFiRun(runKey:string):Promise<FaultInjectionRun|null>{return(await coreFiRpc<{run:FaultInjectionRun|null}>('read_run',{runKey})).run;}
export async function listCoreFiWorkers(after?:number):Promise<FaultInjectionWorker[]>{return(await coreFiRpc<{workers:FaultInjectionWorker[]}>('workers',after===undefined?{}:{after})).workers;}
export async function refreshCoreFiProgress(taskId:string){return(await coreFiRpc<{task:FaultInjectionTask|null}>('progress',{taskId})).task;}
export const newCoreFiId=()=> 'fi_'+randomUUID().replaceAll('-','');

export async function resolveFiUser(request:Request){
 return {username:coreFiOwner(),apiKey:null};
}
