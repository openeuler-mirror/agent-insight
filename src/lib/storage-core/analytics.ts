import { compatibilityContext, compatibilityFailure, configuredCoreBackgroundActors, type CompatibilityOptions } from './compat';
import { requestCore } from './server';
import { controllerHeaders } from './controller';
import { buildAnalyticsProjection, type AnalyticsProjection, type AnalyticsExecution } from './analytics-projection';
import type { ReliabilityEventRow } from '../fleet/reliability';
import {bucketStarts,normalizeWindow,planOf} from '../fleet/agg';
import type {CoreOutcomeLookup} from './trace-outcome-projection';

type Actor = Awaited<ReturnType<typeof compatibilityContext>>;
type Execution = Omit<AnalyticsExecution,'timestamp'> & {timestamp:Date};
export interface AnalyticsItem {trace_id:string;boundary:string;projection:AnalyticsProjection}
type Query = {where?:Record<string,unknown>;orderBy?:Record<string,'asc'|'desc'>;take?:number;select?:unknown};
function fail(message:string,status=503):never {throw Object.assign(new Error(message),{status});}
function indexing(message:string):never {throw Object.assign(new Error(message),{status:503,code:'ANALYTICS_INDEXING'});}
export function analyticsFailure(error:unknown):Response {
  if(error&&typeof error==='object'&&'code'in error&&error.code==='ANALYTICS_INDEXING')return Response.json({error:'Analytics summaries are indexing',code:'ANALYTICS_INDEXING'},{status:503,headers:{'retry-after':'1','x-storage-retry':'analytics-indexing','cache-control':'no-store'}});
  if(error&&typeof error==='object'&&'code'in error&&['ANALYTICS_SOURCE_TOO_LARGE','ANALYTICS_SOURCE_UNAVAILABLE'].includes(String(error.code)))return Response.json({error:error.code==='ANALYTICS_SOURCE_TOO_LARGE'?'Analytics source exceeds the supported byte budget':'Analytics source cannot be projected',code:error.code},{status:error.code==='ANALYTICS_SOURCE_TOO_LARGE'?413:503,headers:{'cache-control':'no-store'}});
  return compatibilityFailure(error);
}
async function rpc(actor:Actor,action:string,payload:Record<string,unknown>,options:CompatibilityOptions={},privateCall=false):Promise<Record<string,unknown>> {
  const body=JSON.stringify({action,workspace_id:actor.workspace,...payload});
  const headers=privateCall?await controllerHeaders(actor,body,'trace-analytics/v1'):undefined;
  const {data}=await requestCore('/v1/compat/analytics?'+new URLSearchParams({workspace_id:actor.workspace}),{token:actor.token,method:'POST',body,headers,responseLimit:action==='prepare'?128*1024*1024:12*1024*1024,timeoutMs:['prepare','prepare_sources'].includes(action)?300_000:30_000},options.fetcher||fetch);
  if(!data.value || typeof data.value!=='object' || Array.isArray(data.value))fail('Analytics response unavailable');
  return data.value as Record<string,unknown>;
}
function matches(row:Execution,where:Record<string,unknown>):boolean {
  return Object.entries(where).every(([key,condition])=>{
    if(key==='OR'||key==='AND') {
      if(!Array.isArray(condition))fail('Unsupported analytics predicate');
      return key==='OR'?condition.some(part=>matches(row,part)):condition.every(part=>matches(row,part));
    }
    if(!(key in row))fail('Unsupported analytics field: '+key);
    if(condition===undefined)return true;
    const value=row[key as keyof Execution];
    const comparable=(input:unknown)=>input instanceof Date?input.getTime():input;
    if(condition && typeof condition==='object' && !(condition instanceof Date)) {
      return Object.entries(condition).every(([operator,operand])=>{
        if(operator==='in')return Array.isArray(operand)&&operand.includes(value);
        if(operator==='not')return value!==operand;
        const left=comparable(value) as number; const right=comparable(operand) as number;
        if(operator==='gte')return left>=right;if(operator==='gt')return left>right;
        if(operator==='lte')return left<=right;if(operator==='lt')return left<right;
        fail('Unsupported analytics operator');
      });
    }
    return comparable(value)===comparable(condition);
  });
}
export function createAnalyticsSource(username:string,items:AnalyticsItem[],events:ReliabilityEventRow[]=[],outcomes:Record<string,CoreOutcomeLookup>={}) {
  const rows:Execution[]=[];
  const currentOutcomes=new Map<string,CoreOutcomeLookup>();
  const identities=new Set<string>();
  const originals=new Set(items.map(item=>item.projection?.executions?.[0]?.id));
  for(const item of items) {
    if(item.projection?.version!==1 || !Array.isArray(item.projection.executions) || !Array.isArray(item.projection.errors))fail('Unsupported analytics projection');
    for(const [index,raw] of item.projection.executions.entries()) {
      if(index>0&&originals.has(raw.id))continue;
      if(identities.has(raw.id))fail('Ambiguous analytics execution identity',409);
      identities.add(raw.id);
      const timestamp=new Date(raw.timestamp);if(!Number.isFinite(timestamp.getTime()))fail('Invalid analytics timestamp');
      const row={...raw,timestamp};
      const current=index===0?outcomes[item.trace_id]:undefined;
      if(current){
        currentOutcomes.set(raw.id,current);
        const value=current.outcome?.value;
        if(value){
          row.isAnswerCorrect=value.is_answer_correct;row.failures=JSON.stringify(value.failures);row.skillIssues=value.skill_issues===null?null:JSON.stringify(value.skill_issues);
          const metadata=value.record_projection;
          if(metadata){
            if(Object.hasOwn(metadata,'skill'))row.skill=metadata.skill??null;
            if(Object.hasOwn(metadata,'skill_version'))row.skillVersion=metadata.skill_version;
            if(Array.isArray(metadata.invokedSkills)){row.invokedSkills=JSON.stringify(metadata.invokedSkills);row.executionSkills=metadata.invokedSkills.map(skill=>({skillName:skill.name,version:skill.version??null}));}
            row.skillTriggerRate=metadata.skill_trigger_rate;
          }
        }
        if(current.answer_reset){
          row.isAnswerCorrect=false;
          if(current.answer_reset.query_projection)row.skillTriggerRate=current.answer_reset.query_projection.skill_trigger_rate;
        }
      }
      rows.push(row);
    }
  }
  return {
    username,items,events,rows,
    currentOutcome(id:string){return currentOutcomes.get(id)??null;},
    staticUsers:[username],
    findMany(query:Query={}) {
      let result=rows.filter(row=>matches(row,query.where||{}));
      if(query.orderBy)for(const [key,direction] of Object.entries(query.orderBy).reverse()) {
        if(!['timestamp','id'].includes(key))fail('Unsupported analytics sort');
        result=[...result].sort((a,b)=>{const x=a[key as 'id'|'timestamp'],y=b[key as 'id'|'timestamp'];return(x<y?-1:x>y?1:0)*(direction==='desc'?-1:1);});
      }
      return query.take===undefined?result:result.slice(0,query.take);
    },
    count(query:Query={}) {return rows.filter(row=>matches(row,query.where||{})).length;},
    traceTaskId(id:string) {
      const row=rows.find(row=>row.id===id);if(!row)fail('Analytics execution identity unavailable');
      if(originals.has(id))return row.taskId;
      const parent=items.find(item=>item.projection.executions.some(child=>child.id===id))?.projection.executions[0];
      if(!parent)fail('Analytics parent Trace identity unavailable');
      return parent.taskId;
    },
    skillRows(ids:string[]) {const selected=new Set(ids);return rows.filter(row=>selected.has(row.id)).flatMap(row=>row.executionSkills);},
    collaborations(from:Date) {return items.flatMap(item=>[item.projection.collaboration,...(item.projection.collaboration.children||[]).filter(child=>!originals.has(child.executionId))]).filter(row=>row.candidate&&row.startTime&&Date.parse(row.startTime)>=from.getTime()).sort((a,b)=>Date.parse(b.startTime!)-Date.parse(a.startTime!));},
  };
}
export type AnalyticsSource=ReturnType<typeof createAnalyticsSource> & {actor:Actor;validate:()=>Promise<void>;enrich:(traceIds:string[])=>Promise<Record<string,unknown>>};
export interface CoreAgentMetadata {
  trace_id:string;boundary:string;executionId:string;taskId:string;user:string;agentId:string|null;
  agentName:string;framework:string;timestamp:string;interactions?:{role?:string;agent?:string;subagent_name?:string}[];
}
export async function readCoreAgentMetadata(source:AnalyticsSource,options:CompatibilityOptions={}):Promise<CoreAgentMetadata[]> {
  const principalUsername=source.actor.principalUsername;
  if(!principalUsername)fail('Verified Agent owner identity unavailable');
  const recent=new Set(source.items.map(item=>item.projection.executions[0]).filter(row=>row.user===principalUsername&&row.taskId&&row.framework).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)).slice(0,300).map(row=>row.id));
  const result:CoreAgentMetadata[]=[];
  for(let offset=0;offset<source.items.length;offset+=200) {
    const selected=source.items.slice(offset,offset+200);
    const value=await rpc(source.actor,'agent_metadata',{items:selected.map(item=>({trace_id:item.trace_id,boundary:item.boundary,registrations:recent.has(item.projection.executions[0].id)}))},options);
    if(!Array.isArray(value.items)||value.items.length!==selected.length)fail('Agent metadata coverage unavailable');
    for(const [index,raw] of value.items.entries()) {
      const row=raw as CoreAgentMetadata;const expected=selected[index];const execution=expected.projection.executions[0];
      if(!row||row.trace_id!==expected.trace_id||row.boundary!==expected.boundary||row.executionId!==execution.id||row.taskId!==execution.taskId||row.user!==execution.user||row.agentId!==null&&typeof row.agentId!=='string'||!Number.isFinite(Date.parse(row.timestamp)))fail('Agent metadata source differs',409);
      if(recent.has(execution.id)&&(!Array.isArray(row.interactions)||row.interactions.some(item=>!item||Object.entries(item).some(([key,value])=>!['role','agent','subagent_name'].includes(key)||typeof value!=='string'))))fail('Agent registration inputs unavailable');
      result.push(row);
    }
  }
  await source.validate();return result;
}
const stateKey=Symbol.for('agent-insight.storage-core.analytics-worker');
type Job={actor:Actor;trace:string;boundary:string;options:CompatibilityOptions;sourceRun?:{experiment_id:string;run_id:string}};
const globals=globalThis as unknown as Record<symbol,{jobs:Map<string,Job>;inflight:Set<string>;failures:Map<string,{status:number;retryAt:number}>;active:boolean;timer?:ReturnType<typeof setInterval>}>;
const state=globals[stateKey] ||= {jobs:new Map(),inflight:new Set(),failures:new Map(),active:false};
state.inflight ||= new Set();state.failures ||= new Map();
function jobKey(actor:Actor,trace:string,boundary?:string){return [actor.principal,actor.workspace,'trace',trace,...(boundary===undefined?[]:[boundary])].join('\0');}
function schedule(actor:Actor,pending:{trace_id:string;boundary:string}[],options:CompatibilityOptions) {
  for(const row of pending) {
    if(state.jobs.size>=1000)break;
    const key=jobKey(actor,row.trace_id);
    if(state.jobs.has(key)||state.inflight.has(key)||(state.failures.get(jobKey(actor,row.trace_id,row.boundary))?.retryAt||0)>Date.now())continue;
    state.jobs.set(key,{actor,trace:row.trace_id,boundary:row.boundary,options});
  }
  if(!state.active)void drain();
}
async function drain() {
  state.active=true;
  try {
    while(state.jobs.size) {
      const [key,job]=state.jobs.entries().next().value!;state.jobs.delete(key);
      const failureKey=job.sourceRun?key:jobKey(job.actor,job.trace,job.boundary);
      state.inflight.add(key);let phase='prepare';
      try {
        if(job.sourceRun) {await rpc(job.actor,'prepare_sources',job.sourceRun,job.options,true);continue;}
        const input=await rpc(job.actor,'prepare',{trace_id:job.trace,parser_version:1},job.options,true);
        if(typeof input.boundary!=='string')fail('Analytics source boundary missing');
        phase='compute';
        const projection=buildAnalyticsProjection(input as unknown as Parameters<typeof buildAnalyticsProjection>[0]);
        phase='publish';
        await rpc(job.actor,'publish',{trace_id:job.trace,boundary:input.boundary,parser_version:1,projection},job.options,true);
        state.failures.delete(failureKey);
      }catch(error) {
        const status=error&&typeof error==='object'&&'status'in error?Number(error.status):503;
        if(state.failures.size>=1000)state.failures.delete(state.failures.keys().next().value!);
        state.failures.set(failureKey,{status,retryAt:status===413||phase==='compute'?Infinity:Date.now()+5000});
        console.warn('[storage analytics] projection pending', {status});
      }finally{state.inflight.delete(key);}
    }
  }finally{state.active=false;}
}
function selectionFor(request:Request):Record<string,unknown> {
  const url=new URL(request.url);const selection:Record<string,unknown>={};
  if(url.pathname.startsWith('/api/fleet/')) {
    const plan=planOf(normalizeWindow(url.searchParams.get('window')));
    selection.from_ms=bucketStarts(new Date(),plan)[0]-(url.pathname.endsWith('/trends')?plan.count*plan.step:0);
  }
  if(url.pathname==='/api/observe/task-insight') {
    const range=url.searchParams.get('range');if(range!=='all')selection.from_ms=Date.now()-(['7','30','90'].includes(range||'')?Number(range):7)*86400000;
  }
  if(url.pathname==='/api/quality/report') {
    const window=url.searchParams.get('window');
    selection.from_ms=window==='custom'?Date.parse(url.searchParams.get('from')||''):Date.now()-(window==='1d'?1:window==='1m'?30:7)*86400000;
    selection.to_ms=window==='custom'?Date.parse(url.searchParams.get('to')||''):Date.now();
  }
  if(url.pathname==='/api/quality/executions')for(const [query,key] of [['from','from_ms'],['to','to_ms']])if(url.searchParams.has(query))selection[key]=Date.parse(url.searchParams.get(query)!);
  const agent=url.pathname==='/api/fleet/agent'?url.searchParams.get('name'):['/api/quality/report','/api/quality/executions'].includes(url.pathname)?url.searchParams.get('agent'):null;
  if(agent?.trim())selection.agent=agent.trim();
  for(const key of ['from_ms','to_ms'])if(selection[key]!==undefined&&!Number.isFinite(selection[key]))fail('Invalid analytics time range',400);
  return selection;
}
async function readActor(actor:Actor,options:CompatibilityOptions,background=false,selection:Record<string,unknown>={},includeRas=true):Promise<AnalyticsSource> {
  if(!actor.username)fail('Verified analytics identity required',403);
  let cursor:string|undefined;let scope:string|undefined;
  const items:AnalyticsItem[]=[];const pending:{trace_id:string;boundary:string}[]=[];const checked:{trace_id:string;boundary:string}[]=[];const enrichmentTokens:string[]=[];const rasTokens:string[]=[];const outcomeTokens:string[]=[];const outcomes:Record<string,CoreOutcomeLookup>={};const events=new Map<string,ReliabilityEventRow>();
  let pageLimit=200;
  for(;;) {
    let page:Record<string,unknown>;
    try {page=await rpc(actor,'read',{limit:pageLimit,parser_version:1,selection,...(includeRas?{}:{include_ras:false}),...(cursor?{cursor}:{})},options);}
    catch(error) {
      if(error&&typeof error==='object'&&'status'in error&&error.status===413&&pageLimit>1){pageLimit=Math.max(1,Math.floor(pageLimit/2));continue;}
      throw error;
    }
    if(!Array.isArray(page.items)||!Array.isArray(page.pending)||typeof page.scope_fingerprint!=='string')fail('Analytics coverage unavailable');
    if(scope!==undefined&&scope!==page.scope_fingerprint)fail('Authorization changed during analytics read',403);
    scope=page.scope_fingerprint;
    if(page.items.length&&(!page.outcomes||typeof page.outcomes!=='object'||Array.isArray(page.outcomes)||typeof page.outcome_read_token!=='string'))fail('Current Outcome read coverage unavailable');
    for(const item of page.items as AnalyticsItem[]){
      const current=(page.outcomes as Record<string,CoreOutcomeLookup>)[item.trace_id];
      if(!current||typeof current.is_evaluating!=='boolean'||typeof current.selection_hash!=='string'||!/^[0-9a-f]{64}$/.test(current.selection_hash)||current.outcome!==null&&(!current.outcome?.source||current.outcome.source.trace_id!==item.trace_id||current.outcome.source.execution_id!==item.projection.executions[0].id))fail('Current Outcome source differs',409);
      outcomes[item.trace_id]=current;
    }
    if(typeof page.outcome_read_token==='string')outcomeTokens.push(page.outcome_read_token);
    items.push(...page.items as AnalyticsItem[]);pending.push(...page.pending as typeof pending);
    checked.push(...(Array.isArray(page.checked_sources)?page.checked_sources as typeof checked:(page.items as AnalyticsItem[]).map(({trace_id,boundary})=>({trace_id,boundary}))));
    if(items.length+pending.length>100000||checked.length>100000)fail('Analytics scan budget exceeded',413);
    if(Array.isArray(page.ras_events)) for(const row of page.ras_events as ReliabilityEventRow[])events.set(row.id,{...row,ts:new Date(row.ts)});
    if(typeof page.ras_read_token==='string')rasTokens.push(page.ras_read_token);
    const next=page.next_cursor;
    if(next!=null&&typeof next!=='string'||next===cursor)fail('Analytics cursor did not advance');
    cursor=next as string|undefined;
    if(!cursor)break;
  }
  if(pending.length) {
    schedule(actor,pending,options);
    if(!background)for(const row of pending) {
      const failure=state.failures.get(jobKey(actor,row.trace_id,row.boundary));
      if(failure?.retryAt===Infinity)throw Object.assign(new Error('Analytics source coverage unavailable'),{status:failure.status===413?413:503,code:failure.status===413?'ANALYTICS_SOURCE_TOO_LARGE':'ANALYTICS_SOURCE_UNAVAILABLE'});
    }
    if(!background)indexing('Analytics projections are indexing; retry shortly');
  }
  const validate=async()=>{
    for(let offset=0;offset<checked.length;offset+=200) {
      const check=await rpc(actor,'validate',{items:checked.slice(offset,offset+200)},options);
      if(check.scope_fingerprint!==scope)fail('Authorization changed during analytics read',403);
    }
    for(let offset=0;offset<enrichmentTokens.length;offset+=200) {
      const check=await rpc(actor,'validate_enrichment',{read_tokens:enrichmentTokens.slice(offset,offset+200)},options);
      if(check.scope_fingerprint!==scope)fail('Authorization changed during quality enrichment',403);
    }
    for(let offset=0;offset<rasTokens.length;offset+=200) {
      const check=await rpc(actor,'validate_ras',{read_tokens:rasTokens.slice(offset,offset+200)},options);
      if(check.scope_fingerprint!==scope)fail('Authorization changed during RAS statistics',403);
    }
    for(let offset=0;offset<outcomeTokens.length;offset+=200){
      const check=await rpc(actor,'validate_outcomes',{read_tokens:outcomeTokens.slice(offset,offset+200)},options);
      if(check.scope_fingerprint!==scope)fail('Authorization changed during Outcome read',403);
    }
  };
  await validate();
  const enrich=async(traceIds:string[])=>{
    const value=await rpc(actor,'enrich',{trace_ids:traceIds},options);
    if(Array.isArray(value.pending_sources)&&value.pending_sources.length) {
      for(const raw of value.pending_sources) {
        const run=raw as {experiment_id:string;run_id:string};
        if(typeof run.experiment_id!=='string'||typeof run.run_id!=='string')fail('Analytics source index unavailable');
        const key=[actor.principal,actor.workspace,'run',run.run_id].join('\0');
        if(state.jobs.size<1000&&!state.inflight.has(key)&&(state.failures.get(key)?.retryAt||0)<=Date.now())state.jobs.set(key,{actor,trace:'',boundary:'',sourceRun:run,options});
      }
      if(!state.active)void drain();
      indexing('Quality source indexes are preparing; retry shortly');
    }
    if(value.scope_fingerprint!==scope||typeof value.read_token!=='string')fail('Quality enrichment version boundary unavailable');
    enrichmentTokens.push(value.read_token);
    return value;
  };
  return {...createAnalyticsSource(actor.username,items,[...events.values()],outcomes),actor,validate,enrich};
}
export async function readCoreAnalytics(request:Request,options:CompatibilityOptions={}):Promise<AnalyticsSource> {
  const actor=await compatibilityContext(request,options);const selection=selectionFor(request);
  for(let attempt=0;;attempt++) {
    try{return await readActor(actor,options,false,selection,new URL(request.url).pathname!=='/api/ingest/ras-events');}
    catch(error){if(attempt>=2||!error||typeof error!=='object'||!('status'in error)||error.status!==409)throw error;}
  }
}
export function startCoreAnalyticsBackground() {
  if(state.timer)return;
  const poll=async()=>{
    try {
      const configured=await configuredCoreBackgroundActors();
      for(const actor of configured.actors)await readActor(actor,{},true);
    }catch {console.warn('[storage analytics] background identity or source unavailable');}
  };
  state.timer=setInterval(()=>{if(!state.active)void poll();},30_000);state.timer.unref();void poll();
}
export async function ingestCoreRas(request:Request,events:Record<string,unknown>[],options:CompatibilityOptions={}) {
  let actor:Awaited<ReturnType<typeof compatibilityContext>>;
  if(!request.headers.has('authorization')&&!request.headers.has('x-witty-api-key')) {
    const username=process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER?.trim();if(!username)fail('Explicit RAS ingestion identity required',401);
    const {configuredCoreBackgroundActorForUser}=await import('./compat');actor=await configuredCoreBackgroundActorForUser(username,options);
  }else actor=await compatibilityContext(request,options);
  if(!actor.token.startsWith('api_'))fail('Collector API credential required',403);
  return rpc(actor,'ras_ingest',{events},options,true);
}

export type CoreRasEvent=ReliabilityEventRow & {user:string;rasSessionKey:string|null;executionId:string|null};
export async function readCoreRasEvents(request:Request,taskIds:string[]=[],selection:{limit?:number;types?:string[];order?:'asc'|'desc'}={},options:CompatibilityOptions={}) {
  const actor=await compatibilityContext(request,options);
  const value=await rpc(actor,'ras_read',{task_ids:taskIds,selection},options);
  if(!Array.isArray(value.events)||typeof value.read_token!=='string'||typeof value.scope_fingerprint!=='string'||!value.execution_ids||typeof value.execution_ids!=='object')fail('RAS read coverage unavailable');
  const events=value.events.map(raw=>{
    const row=raw as CoreRasEvent;const ts=new Date(row.ts);
    if(typeof row.id!=='string'||typeof row.taskId!=='string'||typeof row.user!=='string'||!Number.isFinite(ts.getTime()))fail('Invalid RAS event source');
    return {...row,ts};
  });
  const validate=async()=>{const check=await rpc(actor,'validate_ras_read',{read_token:value.read_token},options);if(check.scope_fingerprint!==value.scope_fingerprint)fail('RAS authorization changed',403);};
  return {actor,events,executionIds:value.execution_ids as Record<string,string|null>,hasMore:value.has_more===true,validate};
}

export async function readCoreRasMetadata(request:Request,limit:number,options:CompatibilityOptions={}) {
  const actor=await compatibilityContext(request,options);const value=await rpc(actor,'ras_read',{task_ids:[],selection:{limit,view:'metadata'}},options);
  if(!Array.isArray(value.events)||typeof value.read_token!=='string'||typeof value.scope_fingerprint!=='string')fail('RAS metadata coverage unavailable');
  const rows=value.events.map(raw=>{
    const row=raw as {taskId:string;user:string;platform:string|null;framework:string|null;ts:string};const ts=new Date(row.ts);
    if(typeof row.taskId!=='string'||typeof row.user!=='string'||!Number.isFinite(ts.getTime()))fail('Invalid RAS metadata source');
    return {...row,ts};
  });
  const validate=async()=>{const check=await rpc(actor,'validate_ras_read',{read_token:value.read_token},options);if(check.scope_fingerprint!==value.scope_fingerprint)fail('RAS authorization changed',403);};
  return {actor,rows,validate};
}

export async function deleteCoreRas(request:Request,taskIds:string[],options:CompatibilityOptions={}){
 const actor=await compatibilityContext(request,options);return rpc(actor,'ras_delete',{task_ids:taskIds},options,true);
}
