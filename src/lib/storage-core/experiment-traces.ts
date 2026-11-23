import type {CoreExperimentContext} from './experiments';
import {requestCore} from './server';
export type CoreTraceRecord=Record<string,unknown>;
export async function readCoreExperimentTraces(context:CoreExperimentContext,params:URLSearchParams=new URLSearchParams()):Promise<CoreTraceRecord[]>{
 const query=new URLSearchParams(params);query.set('workspace_id',context.actor.workspace);query.delete('user');query.delete('paginated');
 const {data}=await requestCore('/v1/compat/observe/data?'+query,{token:context.actor.token,responseLimit:128*1024*1024,timeoutMs:120000},context.options.fetcher||fetch);
 if(!Array.isArray(data.value)||data.value.length>100000)throw Object.assign(new Error('Complete authorized Trace selection required'),{status:503});return data.value as CoreTraceRecord[];
}
