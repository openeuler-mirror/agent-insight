import {getActiveCoreCollectorIdentity} from './collector-identity';
import {collectorPrivate} from './collector-entry';
import {getCoreSessionScope} from './session-source';
import {getCoreExperimentContext} from './experiments';
import {requestCore} from './server';
import {isStorageCoreEnabled} from './mode';
type Row=Record<string,any>;
export interface CollectorTraceQuery {references?:string[];agent_session_ids?:string[];framework?:string;prefix?:string;limit?:number;include_session?:boolean;}
export function hasCoreCollectorTraceSource(){return isStorageCoreEnabled();}
export async function queryCoreTraceSources(user:string|undefined,query:CollectorTraceQuery):Promise<Array<{source:Row;execution:Row|null;session:Row|null}>>{
 const identity=getActiveCoreCollectorIdentity();let rows:Row[];
 if(identity){if(user&&identity.username!==user)throw Object.assign(new Error('Collector trace owner differs'),{status:403});rows=await collectorPrivate(identity,'query_sessions',{...query,legacy_username:user||identity.username});}
 else{
  const session=getCoreSessionScope(),experiment=getCoreExperimentContext();const scope=session||experiment;if(!scope)throw Object.assign(new Error('Verified Trace read scope required'),{status:503});
  const {data}=await requestCore('/v1/compat/observe/session-sources?'+new URLSearchParams({workspace_id:scope.actor.workspace,query:JSON.stringify({...query,legacy_username:user})}),{token:scope.actor.token,responseLimit:128*1024*1024,timeoutMs:65_000},scope.options.fetcher||fetch);rows=data.value as Row[];
 }
 if(!Array.isArray(rows))throw Object.assign(new Error('Invalid Trace source query'),{status:502});
 return rows.map(source=>{const raw=source.session_json?JSON.parse(source.session_json):null;return {source,execution:source.execution?{...source.execution,timestamp:source.execution.timestamp==null?null:new Date(source.execution.timestamp)}:null,session:raw?{...raw,interactions:JSON.stringify(raw.interactions),...(raw.langfuseTraceNodes!==undefined?{langfuseTraceNodes:JSON.stringify(raw.langfuseTraceNodes)}:{}),startTime:new Date(raw.startTime),endTime:raw.endTime?new Date(raw.endTime):null}:null};});
}
export async function findCoreTraceExecutions(user:string|undefined,query:CollectorTraceQuery){return (await queryCoreTraceSources(user,{...query,include_session:false})).flatMap(row=>row.execution?[row.execution]:[]);}
export async function findCoreTraceSession(user:string,taskId:string){return (await queryCoreTraceSources(user,{references:[taskId],limit:2})).find(row=>row.session?.taskId===taskId)?.session??null;}
