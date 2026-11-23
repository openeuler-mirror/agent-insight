import {AsyncLocalStorage} from 'node:async_hooks';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {getCoreExperimentContext,requireCoreExperimentContext} from '@/lib/storage-core/experiments';
import {createExperimentReadView,type ExperimentViewSnapshot} from '@/lib/storage-core/experiment-view';
import {requestCore} from '@/lib/storage-core/server';
import {controllerHeaders} from '@/lib/storage-core/controller';
import {getCoreDatasetContext} from '@/lib/storage-core/datasets';
import type {PrismaClient} from '@prisma/client';

const LIMIT=128*1024*1024;
const viewKey=Symbol.for('agent-insight.storage-core.benchmark-read-view');
const globalViews=globalThis as unknown as Record<symbol,AsyncLocalStorage<PrismaClient>>;
const views=globalViews[viewKey] ||= new AsyncLocalStorage<PrismaClient>();
const trusted=new Set(['cancel_request','cancel_load','cancel_dispatch_bind','cleanup_confirm','cancel_control','prepare_case_retry','prepare_evaluation_retry','import_submissions','classify_failure','claim_intents','finish_intent','resume_work','load_work','load_dispatch','dataset_import','create','start','checkpoint','dispatch_checkpoint','evaluation_prepare','retry_case','retry_evaluation','continuation_finish']);
const reads=new Set(['cancel_control','cancel_load','prepare_case_retry','prepare_evaluation_retry','lookup_operation','dataset_read','dataset_load','dataset_list','read','read_view','list_jobs','load_work','load_dispatch','resume_work','artifact_read','artifact_lookup']);
export const usesCoreBenchmark=()=>isStorageCoreEnabled()||!!getCoreExperimentContext()||!!getCoreDatasetContext()||!!views.getStore();
export const benchmarkCoreContext=()=>getCoreExperimentContext()||getCoreDatasetContext()||requireCoreExperimentContext();
export async function benchmarkCoreRpc<T=unknown>(action:string,payload:Record<string,unknown>={}):Promise<T>{
 const context=benchmarkCoreContext();
 const body=JSON.stringify({...payload,action,...(!reads.has(action)?{operation_key:payload.operation_key||context.operationKey,operation_request:payload.operation_request||{action,payload}}:{})});
 if(Buffer.byteLength(body,'utf8')>LIMIT)throw Object.assign(new Error('Benchmark request too large'),{status:413});
 const headers=trusted.has(action)?await controllerHeaders(context.actor,body,'experiment-frozen-assets/v1'):{};
 for(let attempt=0;attempt<3;attempt++){
  try{const response=await requestCore('/v1/compat/benchmarks?'+new URLSearchParams({workspace_id:context.actor.workspace}),{token:context.actor.token,method:'POST',body,headers,responseLimit:LIMIT,timeoutMs:120_000},context.options.fetcher||fetch);if(!Object.hasOwn(response.data,'value'))throw Object.assign(new Error('Invalid Benchmark response'),{status:502});return response.data.value as T;}
  catch(error){const status=error&&typeof error==='object'&&'status'in error?error.status:undefined;if(attempt===2||(status!==undefined&&status!==502&&status!==503))throw error;await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));}
 }
 throw Object.assign(new Error('Benchmark storage unavailable'),{status:503});
}
export function benchmarkReadSource<T>(legacy:T):T{
 const view=views.getStore();if(view)return view as T;
 if(usesCoreBenchmark())throw Object.assign(new Error('Complete Benchmark read view required'),{status:503});
 return legacy;
}
export async function withCoreBenchmarkReadView<T>(experimentId:string,action:()=>Promise<T>):Promise<T>{
 const context=benchmarkCoreContext();
 const result=await benchmarkCoreRpc<{coverage:string;snapshots:ExperimentViewSnapshot[]}>('read_view',{experiment_id:experimentId});
 if(result?.coverage!=='complete'||!Array.isArray(result.snapshots))throw Object.assign(new Error('Complete Benchmark read view required'),{status:503});
 return views.run(createExperimentReadView(result.snapshots,{actorUsername:context.actor.username}),action);
}
export async function readCoreBenchmarkArtifact(input:{artifactId:string;evaluationId?:string;user:string}):Promise<{name:string;mediaType:string;sha256:string;sizeBytes:number;bytes:Buffer}>{
 const context=benchmarkCoreContext();if(input.user!==context.actor.username)throw Object.assign(new Error('Benchmark actor mismatch'),{status:403});
 const value=await benchmarkCoreRpc<{name:string;mediaType:string;sha256:string;sizeBytes:number;bytes_base64:string}>('artifact_lookup',{artifact_id:input.artifactId,...(input.evaluationId?{job_id:input.evaluationId}:{})});
 return {...value,bytes:Buffer.from(value.bytes_base64,'base64')};
}

export interface BenchmarkCallbackContext {capability:string;verifiedDeviceClientId?:string;verifiedDeviceOwner?:string;fetcher?:typeof fetch}
export async function benchmarkCallbackRpc<T=unknown>(context:BenchmarkCallbackContext,action:string,payload:Record<string,unknown>):Promise<T>{
 const capability=context.capability;
 if(!/^bcap_[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(capability)||capability.length>4096)throw Object.assign(new Error('Benchmark callback credential required'),{status:401});
 let actor:{principal:string;workspace:string};
 try{const encoded=capability.slice(5).split('.')[0];const parsed=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));if(typeof parsed.principal_id!=='string'||typeof parsed.workspace_id!=='string')throw Error();actor={principal:parsed.principal_id,workspace:parsed.workspace_id};}catch{throw Object.assign(new Error('Invalid Benchmark callback credential'),{status:401});}
 const clean={...payload};delete clean.verified_device_client_id;
 const body=JSON.stringify({...clean,action,...(context.verifiedDeviceClientId?{verified_device_client_id:context.verifiedDeviceClientId}:{})});
 if(Buffer.byteLength(body,'utf8')>LIMIT)throw Object.assign(new Error('Benchmark callback request too large'),{status:413});
 const headers:Record<string,string>={'x-agent-insight-callback-token':capability};
 if(context.verifiedDeviceClientId){headers['x-benchmark-device-client']=context.verifiedDeviceClientId;headers['x-storage-benchmark-device-proof']=(await controllerHeaders(actor,body,'benchmark-device/v1'))['x-storage-controller-proof'];}
 if(['execution_stage','claim_next_execution','submission_reject','load_work','load_next_work','load_normalization_work','evaluation_prepare','normalize_commit','load_child_dispatch','child_dispatch_checkpoint','normalization_fail'].includes(action))Object.assign(headers,await controllerHeaders(actor,body,'experiment-frozen-assets/v1'));
 const response=await requestCore('/v1/compat/benchmark-callback',{method:'POST',body,headers,responseLimit:LIMIT,timeoutMs:120_000},context.fetcher||fetch);
 if(!Object.hasOwn(response.data,'value'))throw Object.assign(new Error('Invalid Benchmark callback response'),{status:502});return response.data.value as T;
}
