import { compatibilityContext, type CompatibilityOptions } from './compat';
import { requestCore } from './server';
import {withCoreReadRetry,bindCoreReadIdentity} from './read-retry';

export const TRACE_EVIDENCE_BYTES=16*1024*1024;
export interface TraceEvidenceValue {
  format:'agent-insight.trace-evidence';
  version:1;
  captured_at:string;
  snapshot_hash:string;
  manifest:Record<string,unknown> & {workspace_id:string;trace_id:string};
  execution:Record<string,unknown> & {id:string;taskId:string;query?:string|null;finalResult?:string|null;framework?:string|null};
  session:Record<string,unknown> & {taskId:string;interactions:unknown[];query?:string|null};
}
export type TraceExecutionValue = Omit<TraceEvidenceValue, 'format' | 'session'> & {format:'agent-insight.trace-execution'};
function invalid():never {throw Object.assign(new Error('Trace evidence unavailable'),{status:503});}
function object(value:unknown):value is Record<string,unknown> {return !!value && typeof value==='object' && !Array.isArray(value);}
async function readEvidence(request:Request,refs:{taskId?:string;executionId?:string;traceRef?:string},options:CompatibilityOptions,executionOnly=false,allowMissingSession=false) {
 if(typeof window!=='undefined')throw new Error('Trace evidence is server only');
 const actor=await compatibilityContext(request,options);
 bindCoreReadIdentity(actor);
 if(!actor.username)invalid();
 const query=new URLSearchParams({workspace_id:actor.workspace});
 if(executionOnly)query.set('view','execution');
 else if(allowMissingSession)query.set('view','outcome-edit');
 for(const key of ['taskId','executionId','traceRef'] as const){
  const ref=refs[key];if(ref===undefined)continue;
  if(!ref || ref.length>512 || /[\u0000-\u001f\u007f-\u009f]/.test(ref))throw Object.assign(new Error('Invalid Trace identity'),{status:400});
  query.set(key,ref);
 }
 if(!refs.taskId&&!refs.executionId&&!refs.traceRef)throw Object.assign(new Error('Trace identity required'),{status:400});
 const {data}=await requestCore('/v1/compat/observe/evidence?'+query,{token:actor.token,responseLimit:TRACE_EVIDENCE_BYTES+1024,timeoutMs:65_000,signal:request.signal},options.fetcher||fetch);
 const value=data.value;
 if(!object(value)||value.format!==(executionOnly?'agent-insight.trace-execution':'agent-insight.trace-evidence')||value.version!==1||typeof value.captured_at!=='string'||!Number.isFinite(Date.parse(value.captured_at))||typeof value.snapshot_hash!=='string'||!/^[0-9a-f]{64}$/.test(value.snapshot_hash)
  ||!object(value.manifest)||value.manifest.workspace_id!==actor.workspace||typeof value.manifest.trace_id!=='string'
  ||!object(value.execution)||typeof value.execution.id!=='string'||typeof value.execution.taskId!=='string'
  ||(executionOnly?'session'in value:allowMissingSession&&value.session===null?false:!object(value.session)||value.session.taskId!==value.execution.taskId||!Array.isArray(value.session.interactions)))invalid();
 for(const field of ['query','finalResult','framework']){const entry=value.execution[field];if(entry!==undefined&&entry!==null&&typeof entry!=='string')invalid();}
 if(Buffer.byteLength(JSON.stringify(value),'utf8')>TRACE_EVIDENCE_BYTES)throw Object.assign(new Error('Trace evidence exceeds byte budget'),{status:413});
 return {evidence:value as unknown as TraceEvidenceValue|TraceExecutionValue,username:actor.username};
}

async function guardedRead(request:Request,refs:{taskId?:string;executionId?:string;traceRef?:string},options:CompatibilityOptions,executionOnly=false,allowMissingSession=false) {
 try {return await withCoreReadRetry(request,()=>readEvidence(request,refs,options,executionOnly,allowMissingSession));}
 catch(error) {
  if(error instanceof Error && 'status'in error && typeof error.status==='number' && [400,401,403,404,409,413,503].includes(error.status))throw error;
  invalid();
 }
}


export async function readTraceEvidence(request:Request,refs:{taskId?:string;executionId?:string;traceRef?:string},options:CompatibilityOptions={}) {
 return guardedRead(request,refs,options) as Promise<{evidence:TraceEvidenceValue;username:string}>;
}

export async function readTraceExecution(request:Request,refs:{taskId?:string;executionId?:string;traceRef?:string},options:CompatibilityOptions={}) {
 return guardedRead(request,refs,options,true) as Promise<{evidence:TraceExecutionValue;username:string}>;
}

export async function readTraceOutcomeEvidence(request:Request,refs:{taskId?:string;executionId?:string;traceRef?:string},options:CompatibilityOptions={}) {
 return guardedRead(request,refs,options,false,true) as Promise<{evidence:Omit<TraceEvidenceValue,'session'>&{session:TraceEvidenceValue['session']|null};username:string}>;
}
