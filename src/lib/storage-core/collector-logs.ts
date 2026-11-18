import {buildContextSupplementEvents,maxTextChars} from '@/lib/ingest/claude-otel/context-supplement';
import {aggregateJiuwenOtlpFromSpans,type JiuwenSpan} from '@/lib/ingest/otel/jiuwen/aggregate';
import {isMultiTraceSpan,traceKeyFor} from '@/lib/ingest/otel/jiuwen/spool';
import {randomUUID} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {resolveCollectorRequest,collectorPrivate,collectorFailure,writeCoreCollectorRecord} from './collector-entry';
import {withCoreCollectorIdentity,collectorIdentityForBackgroundActor,type CoreCollectorIdentity} from './collector-identity';
import {configuredCoreBackgroundActors} from './compat';
import {coreServiceOrigin} from './server';
import {isStorageCoreEnabled} from './mode';
import {normalizeOtlpLogs} from '@/lib/ingest/claude-otel/otlp-json';
import {isCodeAgentOtelEvent} from '@/lib/ingest/codeagent-otel/detect';
import {qwenSkillLogToOtelEvent} from '@/lib/ingest/otel/adapters/qwencode';
import {partitionDeepSeekHarnessOtlpLogs} from '@/lib/ingest/deepseek-harness-otel/detect';
import {normalizeDeepSeekHarnessOtlpLogs} from '@/lib/ingest/deepseek-harness-otel/otlp-json';
import {aggregateClaudeOtelSession} from '@/lib/ingest/claude-otel/aggregator';
import {aggregateCodeAgentOtelSession} from '@/lib/ingest/codeagent-otel/aggregator';
import {aggregateDeepSeekHarnessOtelSession} from '@/lib/ingest/deepseek-harness-otel/aggregator';
import {aggregateOtelTraceSession} from '@/lib/ingest/otel/aggregate';
type Row=Record<string,any>;
interface State {running:boolean;timer?:ReturnType<typeof setInterval>;identities:Map<string,CoreCollectorIdentity>;worker:string;}
const key=Symbol.for('agent-insight.storage-core.collector-logs');const globals=globalThis as unknown as Record<symbol,Map<string,State>>;const states=globals[key] ||= new Map();
function state(){let s=states.get(coreServiceOrigin());if(!s){s={running:false,identities:new Map(),worker:'collector-logs-'+randomUUID()};states.set(coreServiceOrigin(),s);}return s;}
function groups(channel:string,events:Row[]){const rows=new Map<string,Row[]>();for(const event of events){const id=String(event.sessionId||'unknown');const values=rows.get(id)||[];values.push(event);rows.set(id,values);}return [...rows].map(([session_id,events])=>({channel,session_id,events}));}
export async function handleCoreCollectorLogs(request:Request){
 try{
  if(!request.headers.get('content-type')?.includes('application/json'))return Response.json({error:'Only OTLP http/json logs are supported. Set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json.'},{status:415});
  const encoding=(request.headers.get('content-encoding')||'identity').toLowerCase();if(!['gzip','identity'].includes(encoding))throw Object.assign(new Error('Unsupported encoding'),{status:400});
  const raw=encoding==='gzip'?gunzipSync(Buffer.from(await request.arrayBuffer()),{maxOutputLength:64*1024*1024}).toString('utf8'):await request.text();const body=JSON.parse(raw);const identity=await resolveCollectorRequest(request,'snapshot');
  const receivedAt=new Date().toISOString(),partition=partitionDeepSeekHarnessOtlpLogs(body);
  const harness=normalizeDeepSeekHarnessOtlpLogs(partition.harnessBody,{receivedAt,authenticatedUser:identity.username});
  const events=partition.hasRemainingResources?normalizeOtlpLogs(partition.remainingBody,{receivedAt,authenticatedUser:identity.username}):[];
  const isQwen=(event:Row)=>['qwencode','qwen-code'].includes(String(event.resource?.['service.name']||'').toLowerCase())||event.eventName.startsWith('qwen-code.');
  const qwen=events.filter(isQwen),skills=events.map(qwenSkillLogToOtelEvent).filter((item):item is NonNullable<typeof item>=>item!==null),codeagent=events.filter(isCodeAgentOtelEvent),other=events.filter(event=>!isCodeAgentOtelEvent(event)&&!isQwen(event));
  const grouped=[...groups('harness',harness),...groups('codeagent',codeagent),...groups('claude',other),...groups('traces',skills)];
  const accepted=await collectorPrivate(identity,'collector_logs',{log_action:'accept',value:{raw_json:raw,operation_key:request.headers.get('idempotency-key'),legacy_username:identity.username,groups:grouped}});
  kickCoreCollectorLogs(identity);const ids=(channel:string)=>accepted.accepted.filter((row:Row)=>row.channel===channel).map((row:Row)=>row.session_id);
  return Response.json({status:'accepted',received:events.length+harness.length,sessions:[...new Set(accepted.accepted.map((row:Row)=>row.session_id))],frameworks:{codeagent:{received:codeagent.length,sessions:ids('codeagent')},other:{received:other.length,sessions:ids('claude')},qwencode:{received:qwen.length,skills:skills.length,sessions:ids('traces')},'deepseek-harness':{received:harness.length,sessions:ids('harness')}}});
 }catch(error){return collectorFailure(error);}
}
async function consume(identity:CoreCollectorIdentity,work:Row){
 const rpc=(action:string,value:Row={})=>collectorPrivate(identity,'collector_logs',{log_action:action,value:{...work.handle,...value}});let lost:unknown;
 const renew=setInterval(()=>{void rpc('renew').catch(error=>{lost=error;});},10000);renew.unref();
 try{
  if(!work.session_id||work.session_id==='unknown'){await rpc('retry');return;}
  const jiuwen=work.channel==='jiuwen';const jiuwenRecords=jiuwen?aggregateJiuwenWork(work.events,identity.username):null;
  const result=jiuwen?{disposition:jiuwenRecords!.records.length?'persisted':'retry-later',record:jiuwenRecords!.records[0]??null}:work.channel==='claude'?aggregateClaudeOtelSession(work.session_id,work.events):work.channel==='codeagent'?aggregateCodeAgentOtelSession(work.session_id,work.events):work.channel==='harness'?aggregateDeepSeekHarnessOtelSession(work.session_id,work.events):aggregateOtelTraceSession(work.session_id,undefined,work.events);
  if(lost)throw lost;
  if(result.disposition==='retry-later'){await rpc('retry');return;}
  if(result.disposition==='discard'){const reason='reason' in result&&result.reason==='aggregation-limit'?'aggregation-limit':work.channel==='claude'?'context-supplement':work.channel==='codeagent'?'hidden-background':'empty-harness';await rpc('ack',{disposition:'discard',reason});return;}
  const records=jiuwen?jiuwenRecords!.records:[result.record];if(records.some(record=>!record))throw new Error('Telemetry aggregation returned no record');
  const retired=jiuwen?jiuwenRecords!.retired:[];
  await rpc('outputs',{outputs:records.map(record=>record!.task_id),retired});
  const receipts:Row[]=[];
  for(const record of records){
   if(!record)throw new Error('Telemetry aggregation returned no record');
   if(record.user&&record.user!==identity.username)throw Object.assign(new Error('Authenticated telemetry owner differs'),{status:403});
   const saved=await writeCoreCollectorRecord(identity,{...record,user:identity.username,skip_evaluation:false,skip_internal_judgment:true,force_judgment:true},{channel:'consumer',operationKey:'logs:'+work.handle.event_id+':'+work.source_proof.watermark_hash+':'+record.task_id,sourceProof:work.source_proof,receivedAt:new Date(work.received_at_ms)});
   if(!saved.receipt||saved.receipt.source_state!=='indexed')throw Object.assign(new Error('Telemetry remains pending'),{status:503});
   receipts.push({scope_kind:saved.receipt.scope_kind,scope_key:saved.receipt.scope_key,operation_key:saved.receipt.operation_key});
  }
  if(retired.length){const orphans=await rpc('retire_orphans');for(const orphan of orphans){const deadline=Date.now()+60000;for(;;){const status=await collectorPrivate(identity,'status',{task_id:orphan.task_id,operation_key:orphan.operation_key});if(status.state==='indexed')break;if(status.state==='failed'||Date.now()>deadline)throw new Error('Jiuwen retirement awaits indexing');await new Promise(resolve=>setTimeout(resolve,50));}receipts.push(orphan);}}
  if(lost)throw lost;await rpc('ack',{disposition:'indexed',receipts});
 }catch{try{await rpc('retry');}catch{}}finally{clearInterval(renew);}
}
export async function drainCoreCollectorLogs(){const current=state();if(current.running)return;current.running=true;try{
 {const configured=await configuredCoreBackgroundActors({},true);for(const actor of configured.actors){try{current.identities.set(actor.workspace+'\0'+actor.principal,await collectorIdentityForBackgroundActor(actor,{operation:'snapshot'}));}catch(error){if(![401,403].includes(Number((error as Row)?.status)))throw error;}}}
 for(const identity of current.identities.values()){try{const work=await collectorPrivate(identity,'collector_logs',{log_action:'claim',value:{worker_id:current.worker}});for(const item of work)await withCoreCollectorIdentity(identity,()=>consume(identity,item));}catch(error){if(![401,403].includes(Number((error as Row)?.status)))throw error;}}
 }finally{current.running=false;}}
export function kickCoreCollectorLogs(identity?:CoreCollectorIdentity){if(!isStorageCoreEnabled())return;const current=state();if(identity)current.identities.set(identity.workspace+'\0'+identity.principal,identity);if(!current.timer){current.timer=setInterval(()=>{void drainCoreCollectorLogs().catch(()=>{});},1000);current.timer.unref();}void drainCoreCollectorLogs().catch(()=>{});}
export const startCoreCollectorLogs=()=>kickCoreCollectorLogs();
export function stopCoreCollectorLogs(){for(const current of states.values()){if(current.timer)clearInterval(current.timer);current.timer=undefined;current.identities.clear();}}

function aggregateJiuwenWork(spans:JiuwenSpan[],user:string){
 const multi=spans.some(isMultiTraceSpan);const groups=new Map<string,JiuwenSpan[]>();
 for(const span of spans){const key=multi?'stitched':traceKeyFor(span);const rows=groups.get(key)||[];rows.push(span);groups.set(key,rows);}
 const records=[...groups.values()].map(rows=>aggregateJiuwenOtlpFromSpans(rows,{user})).filter((row):row is NonNullable<typeof row>=>row!==null);
 const retired=multi&&records.length?[...new Set(spans.map(span=>'jiuwen-'+traceKeyFor(span)))].filter(task=>!records.some(record=>record.task_id===task)):[];
 return {records,retired};
}

export async function handleCoreCollectorContext(request:Request){
 try{
  if(!request.headers.get('x-witty-api-key'))return Response.json({status:'error',message:'invalid or missing x-witty-api-key'},{status:401});
  if(!request.headers.get('content-type')?.includes('application/json'))return Response.json({status:'error',message:'expected application/json'},{status:415});
  const identity=await resolveCollectorRequest(request,'snapshot');const raw=await request.text();const body=JSON.parse(raw);const sessionId=typeof body.sessionId==='string'?body.sessionId.trim():'';if(!sessionId)return Response.json({status:'error',message:'sessionId is required'},{status:400});
  const {events,truncated}=buildContextSupplementEvents(sessionId,body.items,{receivedAt:new Date().toISOString(),maxTextChars:maxTextChars()});
  await collectorPrivate(identity,'collector_logs',{log_action:'accept',value:{raw_json:raw,operation_key:request.headers.get('idempotency-key'),legacy_username:identity.username,groups:events.length?[{channel:'claude',session_id:sessionId,events}]:[]}});kickCoreCollectorLogs(identity);
  return Response.json({status:'accepted',received:Array.isArray(body.items)?body.items.length:0,stored:events.length,truncated,sessionId});
 }catch(error){return collectorFailure(error);}
}
