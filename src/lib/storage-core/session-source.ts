import {AsyncLocalStorage} from 'node:async_hooks';
import {compatibilityContext,type CompatibilityOptions} from './compat';
import {requestCore} from './server';
import {coreReadChanged,bindCoreReadIdentity} from './read-retry';

type Row=Record<string,any>;
interface SourceSession {collector:boolean;trace_id:string;identity_hash?:string;source_revision:string;annotation_revision:string;session_json:string;execution:Row|null;thread:Row|null;can_write:boolean;can_execute?:boolean;owner_principal_id:string;execution_skills:Row[]}
interface SessionScope {request:Request;actor:Awaited<ReturnType<typeof compatibilityContext>>;options:CompatibilityOptions;values:Map<string,SourceSession>;}
const key=Symbol.for('agent-insight.storage-core.session-source');
const slots=globalThis as unknown as Record<symbol,AsyncLocalStorage<SessionScope>>;
const scopes=slots[key] ||= new AsyncLocalStorage<SessionScope>();
export const getCoreSessionScope=()=>scopes.getStore();
export async function withCoreSessionRead<T>(request:Request,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 const actor=await compatibilityContext(request,options);
 bindCoreReadIdentity(actor);
 return scopes.run({request,actor,options,values:new Map()},action);
}
async function rpc(path:string){
 const scope=getCoreSessionScope();if(!scope)throw Object.assign(new Error('Session read scope required'),{status:503});
 const {data}=await requestCore(path,{token:scope.actor.token,responseLimit:128*1024*1024,timeoutMs:65_000,signal:scope.request.signal},scope.options.fetcher||fetch);
 if(!Object.hasOwn(data,'value'))throw Object.assign(new Error('Invalid Session source response'),{status:502});return data.value;
}
export async function readCoreStoredSession(taskId:string,refresh=false):Promise<{source:SourceSession;session:Row|null;execution:Row|null;thread:Row|null}|null>{
 const scope=getCoreSessionScope();if(!scope)throw Object.assign(new Error('Session read scope required'),{status:503});
 let source=refresh?undefined:scope.values.get(taskId);
 if(!source){source=await rpc('/v1/compat/observe/session-source?'+new URLSearchParams({workspace_id:scope.actor.workspace,taskId})) as SourceSession;if(!source||typeof source.collector!=='boolean'||source.identity_hash!==undefined&&!/^[a-f0-9]{64}$/.test(source.identity_hash))throw Object.assign(new Error('Invalid Session source response'),{status:502});scope.values.set(taskId,source);}
 if(!source.collector)return null;
 const stored=JSON.parse(source.session_json);const session=stored?{...stored,interactions:JSON.stringify(stored.interactions),...(stored.langfuseTraceNodes!==undefined?{langfuseTraceNodes:JSON.stringify(stored.langfuseTraceNodes)}:{}),startTime:new Date(stored.startTime),...(stored.endTime?{endTime:new Date(stored.endTime)}:{endTime:null})}:null;
 const execution=source.execution?{...source.execution,timestamp:source.execution.timestamp==null?null:new Date(source.execution.timestamp)}:null;
 return {source,session,execution,thread:source.thread};
}
export async function readCoreSessionRelations(taskIds:string[],plan:{parentAgents?:Row;childAgents?:Row;unavailable?:boolean}){
 const scope=getCoreSessionScope();if(!scope)throw Object.assign(new Error('Session read scope required'),{status:503});
 const stored=await rpc('/v1/compat/observe/session-relations?'+new URLSearchParams({workspace_id:scope.actor.workspace,task_ids:JSON.stringify([...new Set(taskIds)])})) as Row;
 const result:Row=Object.create(null);
 for(const task of taskIds){const value=stored[task]||{parent:null,children:[]};const unavailable=plan.unavailable||plan.parentAgents?.[task]?.state==='unavailable';result[task]={parent:plan.parentAgents?.[task]??value.parent??(unavailable?{state:'unavailable'}:null),children:[...(plan.childAgents?.[task]||[]),...value.children.filter((child:Row)=>!(plan.childAgents?.[task]||[]).some((item:Row)=>item.state==='resolved'&&item.taskId===child.taskId))],...(unavailable?{unavailable:true}:{})};}
 return result;
}
export async function revalidateCoreSession(taskId:string){
 const scope=getCoreSessionScope();if(!scope)return;
 const before=scope.values.get(taskId);const current=await readCoreStoredSession(taskId,true);
 if(before&&(!current||before.trace_id!==current.source.trace_id||before.owner_principal_id!==current.source.owner_principal_id||before.identity_hash!==current.source.identity_hash))throw Object.assign(new Error('Session identity changed while reading'),{status:409});
 if(before&&current&&(before.source_revision!==current.source.source_revision||before.annotation_revision!==current.source.annotation_revision||JSON.stringify(before.thread)!==JSON.stringify(current.source.thread))){
  if(before.identity_hash)throw coreReadChanged('Session changed while reading');
  throw Object.assign(new Error('Session changed without a stable identity proof'),{status:409});
 }
}
