import { compatibilityContext, type CompatibilityOptions } from './compat';
import { readCoreBytes, requestCore } from './server';
import { activateGeneration } from './core-generation-worker';
import { PRODUCTION_POLICY } from '@/lib/trace-datasets/sampling/production';
import { platformCatalog } from '@/server/trace-datasets/catalog';

export interface GenerationActor {token:string;workspace:string;principal:string;username:string|null}
export type GenerationRPC=(action:string,body:Record<string,unknown>)=>Promise<unknown>;
export function generationRPC(actor:GenerationActor,options:CompatibilityOptions={}):GenerationRPC {
 return async(action,body)=>{
  const {data}=await requestCore('/v1/compat/datasets/generation?'+new URLSearchParams({workspace_id:actor.workspace}),{
   token:actor.token,method:'POST',body:JSON.stringify({...body,action}),responseLimit:16*1024*1024+4096,timeoutMs:70_000,
  },options.fetcher||fetch);
  if(!Object.hasOwn(data,'value'))throw Object.assign(new Error('Generation service unavailable'),{status:503});
  return data.value;
 };
}
export async function coreGenerationRequest(request:Request,action:string,payload:Record<string,unknown>,options:CompatibilityOptions={}) {
 const actor=await compatibilityContext(request,options);return generationRPC(actor,options)(action,payload);
}
function failure(error:unknown) {
 const status=error&&typeof error==='object'&&'status'in error&&typeof error.status==='number'&&[400,401,403,404,409,410,413,422,429,503].includes(error.status)?error.status:503;
 const safeCodes=['REQUEST_EXPIRED','QUEUE_LIMIT','SOURCE_NOT_AVAILABLE','IDEMPOTENCY_CONFLICT','ALREADY_COMPLETED','DATASET_NOT_READY','DATASET_DELETING','FEATURE_INITIALIZING','FEATURE_UNAVAILABLE','INVALID_CONFIG','NOT_FOUND','UNAUTHENTICATED'];
 const fallback:Record<number,string>={400:'INVALID_CONFIG',401:'UNAUTHENTICATED',403:'FORBIDDEN',404:'NOT_FOUND',410:'REQUEST_EXPIRED',422:'SOURCE_NOT_AVAILABLE',429:'QUEUE_LIMIT'};
 const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&safeCodes.includes(error.code)?error.code:fallback[status]||'RESOURCE_UNAVAILABLE';
 const messages:Record<string,string>={UNAUTHENTICATED:'请重新登录后操作',FORBIDDEN:'无权访问数据集生成任务',REQUEST_EXPIRED:'该请求已结束，请重新提交配置',QUEUE_LIMIT:'后台任务已满，请稍后重试',SOURCE_NOT_AVAILABLE:'该 Agent 在所选时间内没有可访问的 Trace，请重新选择',IDEMPOTENCY_CONFLICT:'请求标识已用于不同配置',ALREADY_COMPLETED:'数据集已生成完成',INVALID_CONFIG:'生成配置无效，请重新选择',NOT_FOUND:'未找到生成任务'};
 return Response.json({error:{code,message:messages[code]||'数据集生成服务暂时不可用，请稍后重试'}},{status,headers:{'cache-control':'no-store'}});
}
export async function handleCoreDatasetGeneration(request:Request,action:string,datasetId?:string,options:CompatibilityOptions={}) {
 try {
  if(typeof window!=='undefined')throw new Error('Generation is server only');
  const actor=await compatibilityContext(request,options);const rpc=generationRPC(actor,options);let value:unknown;
  if(action==='create') {
   const bytes=await readCoreBytes(request.body,64*1024);
   let raw:Record<string,unknown>;
   try {raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error();}
   catch {throw Object.assign(new Error('Invalid JSON config'),{status:400});}
   const config=Object.fromEntries(['name','description','platform','agentKey','from','to','limit','requestId'].filter(key=>Object.hasOwn(raw,key)).map(key=>[key,raw[key]]));
   value=await rpc('create',{config:{...config,policy:PRODUCTION_POLICY,mappingVersion:'stored-interactions-v4',processorVersion:'identity-v1',purpose:'coverage_regression'}});
   if(!value||typeof value!=='object'||!('datasetId'in value)||typeof value.datasetId!=='string')throw new Error('Invalid generation result');
   if(!('historical_inert'in value)||value.historical_inert!==true)activateGeneration(actor,value.datasetId,rpc);
  } else if(action==='progress') {
   value=await rpc(action,{datasetId});if(!value||typeof value!=='object'||!('historical_inert'in value)||value.historical_inert!==true)activateGeneration(actor,datasetId!,rpc);
  } else if(action==='catalog') {
   const params=new URL(request.url).searchParams;const now=Date.now();
   value=await rpc(action,{from:params.get('from')||new Date(now-7*86400000).toISOString(),to:params.get('to')||new Date(now).toISOString(),platform:params.get('platform')||undefined});
   if(value&&typeof value==='object'&&'platforms'in value&&Array.isArray(value.platforms)) {
    const catalog=platformCatalog();value={...value,platforms:value.platforms.map((row:{id:string})=>catalog.get(row.id)||{id:row.id,label:row.id==='otlp'?'OpenTelemetry':row.id})};
   }
  } else value=await rpc(action,action==='deletion'?{deletionId:datasetId}:{datasetId});
  if(value&&typeof value==='object'&&!Array.isArray(value)&&'historical_inert'in value){const {historical_inert,...visible}=value;value=visible;}
  if(action==='release'||((action==='cancel'||action==='remove')&&value===null))return new Response(null,{status:204});
  return Response.json(value,{status:action==='create'||action==='cancel'||action==='remove'?202:200,headers:{'cache-control':'no-store'}});
 } catch(error){return failure(error);}
}
