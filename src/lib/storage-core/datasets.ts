import {runWithCoreControlActor} from './control-context';
import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID,createHash} from 'node:crypto';
import {compatibilityContext,type CompatibilityOptions} from './compat';
import {readCoreBytes,requestCore} from './server';
import {isStorageCoreEnabled} from './mode';
import type {AgentDatasetRecord,AgentDatasetSummary,AgentDatasetReference} from '@/server/agent_datasets_storage';

type DatasetRecord=AgentDatasetRecord&{_storageEtag?:string};
type DatasetSummary=AgentDatasetSummary&{_storageEtag?:string};
type DatasetReference=AgentDatasetReference&{_storageEtag?:string};
export interface CoreDatasetSnapshot<T=DatasetRecord> {
 dataset:T;revision:string;lifecycle_revision:string;release_id:string;etag:string;
 operation_result?:Record<string,unknown>;
}
interface CoreDatasetContext {
 actor:Awaited<ReturnType<typeof compatibilityContext>>&{username:string};
 request:Request;options:CompatibilityOptions;body:Record<string,unknown>;
 operationKey:string;operationKind:string;operationResult?:Record<string,unknown>;
 snapshots:Map<string,CoreDatasetSnapshot>;virtual:Map<string,DatasetRecord>;
 lastWrite?:CoreDatasetSnapshot;
}
class DatasetStorageError extends Error {constructor(readonly status:number,message:string){super(message);}}
const contextKey=Symbol.for('agent-insight.storage-core.dataset-context');
const globalContexts=globalThis as unknown as Record<symbol,AsyncLocalStorage<CoreDatasetContext>>;
const contexts=globalContexts[contextKey] ||= new AsyncLocalStorage<CoreDatasetContext>();
const BYTE_LIMIT=64*1024*1024;
export const getCoreDatasetContext=()=>contexts.getStore();
export function getDatasetRepositoryContext(){
 const context=contexts.getStore();if(!context&&isStorageCoreEnabled())throw new DatasetStorageError(503,'Trusted Dataset repository scope required');return context;
}
export function requireCoreDatasetContext(){
 const context=contexts.getStore();if(!context)throw new DatasetStorageError(503,'Dataset storage context unavailable');return context;
}
export function coreDatasetFailure(cause:unknown):Response {
 const status=cause&&typeof cause==='object'&&'status'in cause&&typeof cause.status==='number'?cause.status:502;
 const message=status===428?'缺少数据版本，请重新加载后再试':status===409?'数据已更新，请重新加载后再试':status===401?'Authentication required':status===403?'Forbidden':status===404?'Dataset not found':status===413?'Dataset exceeds byte budget':'Dataset storage request failed';
 const cas=cause&&typeof cause==='object'&&'datasetCas'in cause&&cause.datasetCas===true;
 return Response.json({error:message},{status,headers:{'cache-control':'no-store',...(cas?{'x-dataset-write-conflict':'1'}:{})}});
}
function validateSnapshot<T extends {id:string}=DatasetRecord>(value:unknown):CoreDatasetSnapshot<T> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new DatasetStorageError(502,'Invalid Dataset response');
 const row=value as CoreDatasetSnapshot<T>;
 if(!row.dataset||typeof row.dataset.id!=='string'||!/^\d+$/.test(String(row.revision))||typeof row.etag!=='string'||!row.etag.startsWith('"')||!row.etag.endsWith('"'))throw new DatasetStorageError(502,'Invalid Dataset version');
 return row;
}
export async function withCoreDatasets<T>(request:Request,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 const actor=await compatibilityContext(request,options);
 if(!actor.username)throw new DatasetStorageError(403,'Verified Dataset identity required');
 let body:Record<string,unknown>={};
 if(request.body){
  const raw=await readCoreBytes(request.clone().body,BYTE_LIMIT);
  if(raw.length||request.method!=='DELETE'){
   try{const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();body=parsed;}catch{throw new DatasetStorageError(400,'JSON object required');}
  }
 }
 const operationKey=request.headers.get('idempotency-key')||randomUUID();
 if(!/^[\x21-\x7e]{1,512}$/.test(operationKey))throw new DatasetStorageError(400,'Invalid operation key');
 const pathname=new URL(request.url).pathname;
 const operationKind=pathname.endsWith('/backflow')?'backflow':request.method==='POST'?'create':request.method==='DELETE'?'delete':'save';
 return contexts.run({actor:{...actor,username:actor.username},request,options,body,operationKey,operationKind,snapshots:new Map(),virtual:new Map()},()=>runWithCoreControlActor({...actor,username:actor.username!},options,action));
}
export async function runWithCoreDatasetActor<T>(actor:{token:string;workspace:string;principal:string;username:string},request:Request,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 const identityUrl=new URL(request.url);identityUrl.search='';identityUrl.searchParams.set('workspace_id',actor.workspace);
 const identityRequest=new Request(identityUrl,{method:'GET',headers:request.headers});
 return withCoreDatasets(identityRequest,async()=>{const context=requireCoreDatasetContext();if(context.actor.principal!==actor.principal||context.actor.workspace!==actor.workspace||context.actor.token!==actor.token)throw new DatasetStorageError(403,'Dataset actor differs');context.actor={...context.actor,username:actor.username};return action();},options);
}
export async function coreDatasetRequest<T=unknown>(action:string,arguments_:Record<string,unknown>={}):Promise<T>{
 const context=requireCoreDatasetContext();
 const body=JSON.stringify({action,...arguments_});
 if(Buffer.byteLength(body,'utf8')>BYTE_LIMIT)throw new DatasetStorageError(413,'Dataset request too large');
 const target='/v1/compat/datasets?'+new URLSearchParams({workspace_id:context.actor.workspace});
 for(let attempt=0;attempt<3;attempt++){
  try{
   const {data}=await requestCore(target,{token:context.actor.token,method:'POST',body,responseLimit:BYTE_LIMIT,timeoutMs:120_000},context.options.fetcher||fetch);
   if(!Object.prototype.hasOwnProperty.call(data,'value'))throw new DatasetStorageError(502,'Invalid Dataset response');
   return data.value as T;
  }catch(cause){
   const status=cause&&typeof cause==='object'&&'status'in cause?cause.status:undefined;
   if(attempt===2||(status!==undefined&&status!==502&&status!==503))throw cause;
   await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
  }
 }
 throw new DatasetStorageError(502,'Dataset request failed');
}
function remember(value:unknown):DatasetRecord {
 const row=validateSnapshot(value);const record={...row.dataset,_storageEtag:row.etag};
 requireCoreDatasetContext().snapshots.set(record.id,{...row,dataset:record});return record;
}
export function listCoreDatasets(view?:'full',targetSkill?:string,includeTrace?:boolean):Promise<DatasetRecord[]>;
export function listCoreDatasets(view:'summary',targetSkill?:string,includeTrace?:boolean):Promise<DatasetSummary[]>;
export function listCoreDatasets(view:'reference',targetSkill?:string,includeTrace?:boolean):Promise<DatasetReference[]>;
export async function listCoreDatasets(view='full',targetSkill?:string,includeTrace=true):Promise<Array<DatasetRecord|DatasetSummary|DatasetReference>>{
 const rows=await coreDatasetRequest<Array<DatasetRecord|DatasetSummary|DatasetReference>>('list',{view,target_skill:targetSkill,include_trace:includeTrace,include_metadata:true});
 if(!Array.isArray(rows))throw new DatasetStorageError(502,'Invalid Dataset list');
 const context=requireCoreDatasetContext();
 const virtual=[...context.virtual.values()].filter(row=>targetSkill===undefined||row.targetSkill===targetSkill).map(row=>{
  if(view==='full')return row;
  const {cases,...metadata}=row;
  if(view==='reference')return {...metadata,caseCount:cases.length,cases:cases.map(({id,input,expectedOutput,evaluationFocus,tags})=>({id,input,expectedOutput,evaluationFocus,tags}))};
  return {...metadata,caseCount:cases.length};
 });
 return [...rows.filter(row=>!context.virtual.has(row.id)),...virtual].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}
export async function findCoreDataset(id:string):Promise<DatasetRecord|null>{
 const context=requireCoreDatasetContext();const virtual=context.virtual.get(id);if(virtual)return virtual;
 const cached=context.snapshots.get(id);if(cached)return cached.dataset;
 const query=new URL(context.request.url).searchParams;const requestedView=context.request.method==='GET'?query.get('view'):undefined;
 const projection=requestedView==='items'||requestedView==='case'?{view:requestedView,case_id:requestedView==='case'?query.get('caseId'):undefined}:{};
 const version=context.request.method==='GET'?query.get('version')||undefined:undefined;
 try{const value=await coreDatasetRequest('get',{dataset_id:id,version,...projection});if(value===null)return null;return remember(value);}
 catch(cause){if(cause&&typeof cause==='object'&&'status'in cause&&cause.status===404)return null;throw cause;}
}
export async function listCoreDatasetVersions(id:string):Promise<Array<CoreDatasetSnapshot<DatasetSummary>>>{
 const value=await coreDatasetRequest<unknown>('versions',{dataset_id:id,view:'summary'});
 if(!Array.isArray(value)||value.length>1000)throw new DatasetStorageError(502,'Invalid Dataset version list');
 const rows=value.map(item=>validateSnapshot<DatasetSummary>(item));
 if(rows.some(row=>!Number.isSafeInteger(row.dataset.caseCount)||row.dataset.caseCount<0||'cases'in row.dataset))throw new DatasetStorageError(502,'Invalid Dataset version summary');
 return rows.sort((a,b)=>BigInt(a.revision)>BigInt(b.revision)?-1:BigInt(a.revision)<BigInt(b.revision)?1:0);
}
export function registerCoreBuiltinDataset(record:AgentDatasetRecord,previousCases:AgentDatasetRecord['cases']=[]):DatasetRecord {
 const context=requireCoreDatasetContext();
 const id=record.id||'builtin-reliability-'+createHash('sha256').update(context.actor.principal).digest('hex').slice(0,32);
 const sourceKey=(item:AgentDatasetRecord['cases'][number])=>String(item.values?.fault_injection_type)+'\0'+String(item.values?.submode||'');
 const previous=new Map(previousCases.map(item=>[sourceKey(item),item.id]));
 const cases=record.cases.map(item=>({...item,id:previous.get(sourceKey(item))||'builtin-'+createHash('sha256').update(id+'\0'+sourceKey(item)).digest('hex').slice(0,32)}));
 const etag='"builtin-'+createHash('sha256').update(JSON.stringify(cases)).digest('hex')+'"';
 const result={...record,cases,id,user:context.actor.username,_storageEtag:etag};context.virtual.set(id,result);return result;
}
export async function seedCoreBuiltinDataset(record:AgentDatasetRecord):Promise<DatasetRecord>{
 const context=requireCoreDatasetContext();const prepared=registerCoreBuiltinDataset(record);
 const existing=await coreDatasetRequest<CoreDatasetSnapshot|null>('lookup',{operation_kind:'builtin-seed',operation_key:prepared.id,operation_request:{preset:'builtin-reliability-v1',dataset_id:prepared.id}});
 if(existing){context.virtual.delete(prepared.id);return remember(existing);}
 try{
  const saved=await coreDatasetRequest('save',{record:prepared,operation_kind:'builtin-seed',operation_key:prepared.id,operation_request:{preset:'builtin-reliability-v1',dataset_id:prepared.id}});
  context.virtual.delete(prepared.id);return remember(saved);
 }catch(cause){if(cause&&typeof cause==='object'&&'status'in cause&&cause.status===403)return prepared;throw cause;}
}
function originalOperation(){const c=requireCoreDatasetContext();return {method:c.request.method,path:new URL(c.request.url).pathname,ifMatch:c.request.headers.get('if-match'),body:c.body};}
function writeConflict(cause:unknown):never {
 if(cause&&typeof cause==='object'&&'status'in cause&&cause.status===409)Object.assign(cause,{datasetCas:true});
 throw cause;
}
export function setCoreDatasetOperationResult(value:Record<string,unknown>){const c=getCoreDatasetContext();if(c)c.operationResult=value;}
async function editableSnapshot(id:string):Promise<CoreDatasetSnapshot>{
 const context=requireCoreDatasetContext();
 if(context.virtual.has(id))throw new DatasetStorageError(403,'Readonly Dataset');
 if(!context.snapshots.has(id))await findCoreDataset(id);
 const current=context.snapshots.get(id);if(!current)throw new DatasetStorageError(404,'Dataset not found');
 const expected=context.request.headers.get('if-match')||(typeof context.body._storageEtag==='string'?context.body._storageEtag:undefined);
 if(!expected)throw new DatasetStorageError(428,'Missing Dataset version');
 if(expected!==current.etag)throw new DatasetStorageError(409,'Dataset changed');
 return current;
}
export const coreDatasetVersionForWrite=editableSnapshot;
export async function saveCoreDataset(record:AgentDatasetRecord,options:{create?:boolean;internal?:boolean}={}):Promise<CoreDatasetSnapshot>{
 const context=requireCoreDatasetContext();
 let current:CoreDatasetSnapshot|undefined;
 if(!options.create){
  if(context.operationKind==='backflow'||options.internal){
   if(!context.snapshots.has(record.id))await findCoreDataset(record.id);
   current=context.snapshots.get(record.id);if(!current)throw new DatasetStorageError(404,'Dataset not found');
  }else current=await editableSnapshot(record.id);
 }
 const reply=await coreDatasetRequest('save',{record,expected_revision:current?.revision,operation_key:context.operationKey,operation_kind:context.operationKind,operation_request:originalOperation(),operation_result:context.operationResult}).catch(writeConflict);
 const value=validateSnapshot(reply);
 const saved=remember(value);Object.assign(record,saved);context.lastWrite={...value,dataset:saved};return context.lastWrite;
}
export async function recordCoreDatasetOperation(id:string):Promise<void>{
 const context=requireCoreDatasetContext();if(!context.snapshots.has(id))await findCoreDataset(id);const current=context.snapshots.get(id);
 if(!current)throw new DatasetStorageError(404,'Dataset not found');
 const result=validateSnapshot(await coreDatasetRequest('record_operation',{dataset_id:id,expected_revision:current.revision,operation_key:context.operationKey,operation_kind:context.operationKind,operation_request:originalOperation(),operation_result:context.operationResult}).catch(writeConflict));
 context.lastWrite=result;
}
export async function deleteCoreDataset(id:string):Promise<boolean>{
 const current=await editableSnapshot(id);const context=requireCoreDatasetContext();
 await coreDatasetRequest('remove',{dataset_id:id,expected_revision:current.revision,operation_key:context.operationKey,operation_request:originalOperation()});return true;
}
export async function cacheCoreDatasetRootCauses(id:string,caseId:string,expectedOutput:string,rootCauses:unknown[],rootCauseMeta:unknown):Promise<boolean>{
 const context=requireCoreDatasetContext();if(!context.snapshots.has(id))await findCoreDataset(id);const current=context.snapshots.get(id);if(!current)return false;
 return coreDatasetRequest<boolean>('cache_root_causes',{dataset_id:id,case_id:caseId,expected_output:expectedOutput,root_causes:rootCauses,root_cause_meta:rootCauseMeta,expected_revision:current.revision});
}
export async function withCoreDatasetRoute(request:Request,next:(request:Request)=>Promise<Response>,options:CompatibilityOptions={}):Promise<Response>{
 try{return await withCoreDatasets(request,async()=>{
  const context=requireCoreDatasetContext();
  if(['POST','PATCH'].includes(request.method)){
   const old=await coreDatasetRequest<CoreDatasetSnapshot|null>('lookup',{operation_key:context.operationKey,operation_kind:context.operationKind,operation_request:originalOperation()});
   if(old){const row=validateSnapshot(old);return Response.json(context.operationKind==='backflow'?row.operation_result:{success:true,dataset:{...row.dataset,_storageEtag:row.etag},warnings:row.operation_result?.warnings||[]},{headers:{etag:row.etag,'cache-control':'no-store'}});}
  }
  if(request.method==='DELETE'){
   const old=await coreDatasetRequest<{removed?:boolean}|null>('lookup',{operation_key:context.operationKey,operation_kind:'delete',operation_request:originalOperation()});
   if(old?.removed)return Response.json({success:true},{headers:{'cache-control':'no-store'}});
  }
  const url=new URL(request.url);url.searchParams.set('user',context.actor.username);
  const headers=new Headers(request.headers);headers.delete('content-length');
  let response:Response|undefined;
  for(let attempt=0;attempt<3;attempt++){
   const normalized=new Request(url,{method:request.method,headers,...(request.body?{body:JSON.stringify({...context.body,user:context.actor.username})}:{})});context.request=normalized;
   response=await next(normalized);
   if(context.operationKind!=='backflow'||response.status!==409||response.headers.get('x-dataset-write-conflict')!=='1'||attempt===2)break;
   await response.body?.cancel();context.snapshots.clear();context.lastWrite=undefined;context.operationResult=undefined;
  }
  if(!response)throw new DatasetStorageError(502,'Dataset response unavailable');
  const resultHeaders=new Headers(response.headers);resultHeaders.set('cache-control','no-store');
  const id=typeof context.body.id==='string'?context.body.id:decodeURIComponent(url.pathname.split('/').at(-1)||'');
  const etag=context.lastWrite?.etag||context.snapshots.get(id)?.etag||context.virtual.get(id)?._storageEtag;
  if(etag)resultHeaders.set('etag',etag);
  return new Response(response.body,{status:response.status,headers:resultHeaders});
 },options);}catch(cause){return coreDatasetFailure(cause);}
}
