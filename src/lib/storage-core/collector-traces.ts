import {decodeOtlpRequest} from '@/lib/ingest/otel/decode';
import {normalizeOtlpTraces} from '@/lib/ingest/otel/normalize';
import {partitionCodeAgentOtlpPayload} from '@/lib/ingest/codeagent-otel/detect';
import {isolateQwenCodeOtelEvent} from '@/lib/ingest/otel/adapters/qwencode';
import {jiuwenServiceName,collectJiuwenSpans} from '@/lib/ingest/otel/jiuwen/aggregate';
import {spanSession,traceKeyFor,isMultiTraceSpan} from '@/lib/ingest/otel/jiuwen/spool';
import {resolveCollectorRequest,collectorPrivate,collectorFailure} from './collector-entry';
import {kickCoreCollectorLogs} from './collector-logs';
export async function handleCoreCollectorTraces(request:Request){
 try{
  let authRequest=request;const authorization=request.headers.get('authorization')||'';let publicUser:string|undefined;
  if(/^Basic /i.test(authorization)||request.headers.has('x-langfuse-secret-key')){
   let secret=request.headers.get('x-langfuse-secret-key')||'';publicUser=request.headers.get('x-langfuse-public-key')||undefined;
   if(/^Basic /i.test(authorization)){const value=Buffer.from(authorization.slice(6).trim(),'base64').toString('utf8');const colon=value.indexOf(':');publicUser=colon>=0?value.slice(0,colon):undefined;secret=colon>=0?value.slice(colon+1):'';}
   if(!publicUser||!secret)throw Object.assign(new Error('Invalid Langfuse credentials'),{status:401});
   const headers=new Headers(request.headers);headers.delete('authorization');headers.set('x-witty-api-key',secret);authRequest=new Request(request.url,{headers});
  }
  const identity=await resolveCollectorRequest(authRequest,'snapshot');if(publicUser&&identity.username!==publicUser)throw Object.assign(new Error('Langfuse owner differs'),{status:401});
  const body=await decodeOtlpRequest(request,'traces');const partition=partitionCodeAgentOtlpPayload(body,'traces');const ignored=partition.codeAgentResourceCount?{ignored:{codeagent:{resourceSpans:partition.codeAgentResourceCount}}}:{};
  if(!partition.hasRemainingResources)return Response.json({status:'accepted',framework:'codeagent',ignored:true,ignoredResourceSpans:partition.codeAgentResourceCount,received:0,sessions:[]});
  const receivedAt=new Date().toISOString();const grouped=new Map<string,any[]>();let count=0,channel='traces';
  const jiuwen=jiuwenServiceName(partition.remainingBody)==='jiuwenswarm';
  if(jiuwen){channel='jiuwen';const spans=collectJiuwenSpans(partition.remainingBody);count=spans.length;for(const span of spans){const id=traceKeyFor(span);const values=grouped.get(id)||[];values.push(span);grouped.set(id,values);}}
  else{const events=normalizeOtlpTraces(partition.remainingBody,{receivedAt,authenticatedUser:identity.username}).map(isolateQwenCodeOtelEvent);count=events.length;for(const event of events){const id=event.sessionId||'unknown';const values=grouped.get(id)||[];values.push(event);grouped.set(id,values);}}
  const accepted=await collectorPrivate(identity,'collector_logs',{log_action:'accept',value:{raw_json:JSON.stringify(body),operation_key:request.headers.get('idempotency-key'),legacy_username:identity.username,groups:[...grouped].map(([session_id,events])=>({channel,session_id,events,...(jiuwen?{session_ids:[...new Set(events.map(spanSession).filter(Boolean))],multi_sessions:[...new Set(events.filter(isMultiTraceSpan).map(spanSession).filter(Boolean))]}:{})}))}});kickCoreCollectorLogs(identity);
  return Response.json(jiuwen?{status:'accepted',framework:'jiuwenswarm',received:count,sessions:accepted.accepted.map((row:any)=>row.session_id),...ignored}:{status:'accepted',received:count,persisted:count,deduplicated:0,sessions:accepted.accepted.map((row:any)=>row.session_id),...ignored});
 }catch(error){return collectorFailure(error);}
}
