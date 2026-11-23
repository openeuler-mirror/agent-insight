import {runWithCoreControlActor} from './control-context';
import { randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { compatibilityContext, type CompatibilityOptions } from './compat';
import { readTraceEvidence, type TraceEvidenceValue } from './evidence';
import { requestCore } from './server';

export type CoreReportKind='agent-debug'|'skills-analysis';
export type CoreReportRow=Record<string,unknown>&{id:string;executionId:string;status:string;interactionsHash:string;revision:string|number;errorMessage?:string|null};
export interface CoreStoredReport {row:CoreReportRow|null;payload:Record<string,unknown>|null;progress:unknown}
export interface CoreReportLease {id:string;revision:string;leaseToken:string}
export interface CoreReportContext {
 request:Request;
 options:CompatibilityOptions;
 actor:Awaited<ReturnType<typeof compatibilityContext>>&{username:string};
 evidence:Map<string,TraceEvidenceValue>;
}
const contextKey=Symbol.for('agent-insight.storage-core.report-context');
const globalContexts=globalThis as unknown as Record<symbol,AsyncLocalStorage<CoreReportContext>>;
const reports=globalContexts[contextKey] ||= new AsyncLocalStorage<CoreReportContext>();
function unavailable():never {throw Object.assign(new Error('Core report context unavailable'),{status:503});}
export function getCoreReportContext(){return reports.getStore();}
export function requireCoreReportContext(){return reports.getStore()||unavailable();}
export async function withCoreReports<T>(request:Request,action:()=>Promise<T>,options:CompatibilityOptions={}):Promise<T>{
 if(typeof window!=='undefined')unavailable();
 const actor=await compatibilityContext(request,options);
 if(!actor.username)unavailable();
 return reports.run({request,options,actor:{...actor,username:actor.username},evidence:new Map()},()=>runWithCoreControlActor({...actor,username:actor.username!},options,action));
}
export async function resolveCoreReportEvidence(ref:string){
 const context=requireCoreReportContext();
 const cached=context.evidence.get(ref);if(cached)return cached;
 const {evidence}=await readTraceEvidence(context.request,{traceRef:ref},context.options);
 context.evidence.set(ref,evidence);context.evidence.set(evidence.execution.id,evidence);context.evidence.set(evidence.execution.taskId,evidence);
 return evidence;
}
export async function coreReportRequest(kind:CoreReportKind,options:{method?:string;executionId?:string;reportId?:string;body?:Record<string,unknown>}={}):Promise<CoreStoredReport&{cached?:boolean;busy?:boolean;leaseToken?:string}>{
 const context=requireCoreReportContext();
 if(!['agent-debug','skills-analysis'].includes(kind))unavailable();
 const query=new URLSearchParams({workspace_id:context.actor.workspace});
 if(options.executionId)query.set('executionId',options.executionId);
 const method=options.method||'GET';const retryable=method==='POST'||method==='PATCH';
 const wireBody=retryable?{...options.body,requestKey:options.body?.requestKey??randomUUID(),...(method==='POST'?{leaseToken:options.body?.leaseToken??randomBytes(32).toString('base64url')}:{})}:options.body;
 const body=wireBody?JSON.stringify(wireBody):undefined;
 if(body&&Buffer.byteLength(body,'utf8')>10*1024*1024)throw Object.assign(new Error('Report exceeds byte budget'),{status:413});
 for(let attempt=0;attempt<3;attempt++){
  try{
   const {data}=await requestCore('/v1/compat/observe/reports/'+kind+(options.reportId?'/'+encodeURIComponent(options.reportId):'')+'?'+query,{token:context.actor.token,method,body,responseLimit:10*1024*1024,timeoutMs:65_000},context.options.fetcher||fetch);
   const value=data.value;
   if(!value||typeof value!=='object'||Array.isArray(value)||!('row'in value)||!('payload'in value)||!('progress'in value))unavailable();
   const result=value as CoreStoredReport&{cached?:boolean;busy?:boolean;leaseToken?:string};
   if(result.row!==null&&(!result.row||typeof result.row!=='object'||typeof result.row.id!=='string'||typeof result.row.executionId!=='string'||typeof result.row.status!=='string'||typeof result.row.interactionsHash!=='string'||!/^\d+$/.test(String(result.row.revision))))unavailable();
   if(result.payload!==null&&(!result.payload||typeof result.payload!=='object'||Array.isArray(result.payload)))unavailable();
   return result;
  }catch(cause){
   const status=cause&&typeof cause==='object'&&'status'in cause?cause.status:undefined;
   if(!retryable||attempt===2||(status!==undefined&&status!==502&&status!==503))throw cause;
   await new Promise(resolve=>setTimeout(resolve,50*(attempt+1)));
  }
 }
 return unavailable();
}
export function readCoreStoredReport(executionId:string,kind:CoreReportKind){return coreReportRequest(kind,{executionId});}
export async function findCoreReportRow(executionId:string,kind:CoreReportKind){
 const value=await readCoreStoredReport(executionId,kind);if(!value.row)return null;
 let payload=value.payload;
 if(value.row.status==='failed'&&payload?.status==='running')payload={...payload,status:'failed',errorMessage:value.row.errorMessage};
 return {...value.row,user:requireCoreReportContext().actor.username,
  reportJson:kind==='agent-debug'&&payload?JSON.stringify(payload):null,
  analysisJson:kind==='skills-analysis'&&payload?JSON.stringify(payload):null,
  __coreProgress:value.progress};
}
