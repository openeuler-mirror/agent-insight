import {createHash,randomUUID} from 'node:crypto';
import {configuredCoreBackgroundActors,type CoreBackgroundActor,type CompatibilityOptions} from './compat';
import {withCoreConfiguredExperiments,requireCoreExperimentContext,runWithCoreExperimentContext,type CoreExperimentContext} from './experiments';
import {readCoreExperimentTraces,type CoreTraceRecord} from './experiment-traces';
import {reconcileCoreCancellation} from './experiment-cancellation';
import {startCoreExperiment} from './experiment-assets';
import {activateExperimentWork,type ExperimentWorkHandle} from './experiment-worker';
import {runCoreTraceWork} from './experiment-trace-worker';
import {runCoreFiWork} from './experiment-fi-worker';
import {startEvalExperimentCases} from '@/lib/engine/experiment/run-experiment';
import {resumeCoreBenchmarkIntents} from '@/lib/benchmark/core-runtime';
import {readPendingCoreBenchmarkCancellations,reconcileCoreBenchmarkCancellation} from '@/lib/benchmark/core-cancellation';

type Row=Record<string,unknown>;
interface Snapshot {gold_redacted?:boolean;experiment:Row;revision?:string;current_run_id?:string|null}
const object=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
function parse(value:unknown):Row{if(typeof value!=='string')return {};try{const result=JSON.parse(value);return object(result)?result:{};}catch{return {};}}
function unavailable(message:string):never{throw Object.assign(new Error(message),{status:503});}
function status(error:unknown){const value=error&&typeof error==='object'&&'status'in error?Number(error.status):503;return [400,401,403,404,409,410,413,422,429,503].includes(value)?value:503;}
const identity=(actor:CoreBackgroundActor,id:string)=>JSON.stringify([actor.workspace,actor.principal,id]);

export function createCoreExperimentBackground(options:{intervalMs?:number;pageSize?:number;concurrency?:number;now?:()=>number;compatibility?:CompatibilityOptions}={}){
 const intervalMs=options.intervalMs??5000,pageSize=options.pageSize??100,concurrency=options.concurrency??4;
 if(!Number.isSafeInteger(intervalMs)||intervalMs<100||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>1000||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>1024)throw Error('Invalid storage background budget');
 const active=new Map<string,Promise<void>>(),cleanup=new Map<string,Promise<void>>(),benchmark=new Map<string,Promise<void>>(),benchmarkCleanup=new Map<string,Promise<void>>(),cancellationCursors=new Map<string,string>(),cursors=new Map<string,string>();
 const observedPlans=new Map<string,Map<string,{runId:string;at:number}>>(),nextWatch=new Map<string,number>();const now=options.now||Date.now;
 let timer:ReturnType<typeof setInterval>|undefined,scanning=false,nextActor=0,lastIssue='';
 function issue(error:unknown){const code=status(error),key=String(code);if(lastIssue!==key){lastIssue=key;console.warn('[storage-core-background] work unavailable',{status:code});}}
 function launch(pool:Map<string,Promise<void>>,key:string,task:()=>Promise<unknown>){
  if(pool.has(key)||pool.size>=concurrency)return false;
  const work=Promise.resolve().then(task).then(()=>{}).catch(issue).finally(()=>{if(pool.get(key)===work)pool.delete(key);});pool.set(key,work);return true;
 }
 function completed(trace:CoreTraceRecord,actor:CoreBackgroundActor,head:Row){
  const enabled=Date.parse(String(head.watchEnabledAt||'')),started=Date.parse(String(trace.trace_started_at||trace.timestamp||'')),ended=Date.parse(String(trace.trace_completed_at||''));
  return trace.user===actor.principalUsername&&trace.agentName===head.agentName&&trace.agentOwnership==='user'&&trace.is_subagent!==true&&trace.trace_status==='success'&&trace.has_failures!==true&&Number.isFinite(enabled)&&Number.isFinite(started)&&started>enabled&&Number.isFinite(ended)&&ended>=started&&typeof trace.task_id==='string'&&!!trace.task_id;
 }
 async function currentWatch(context:CoreExperimentContext,actor:CoreBackgroundActor,source:Snapshot):Promise<Snapshot|null>{
  const current=await context.rpc('read',{experiment_id:source.experiment.id}) as Snapshot;
  if(!current?.experiment||current.gold_redacted||current.experiment.user!==actor.principalUsername)return null;
  const head=current.experiment;
  return !head.deletedAt&&head.watchMode===true&&head.agentName===source.experiment.agentName&&head.watchEnabledAt===source.experiment.watchEnabledAt?current:null;
 }
 function resumable(item:Row,head:Row){
  const marker=item.autoWatchSource;return object(marker)&&marker.version===1&&marker.watchEnabledAt===head.watchEnabledAt&&(!Array.isArray(item.results)||item.results.length===0);
 }
 async function appendDirect(context:CoreExperimentContext,actor:CoreBackgroundActor,snapshot:Snapshot,trace:CoreTraceRecord){
  const head=snapshot.experiment;const cases=Array.isArray(head.cases)?head.cases.filter(object):[];
  const existing=cases.find(row=>row.taskId===trace.task_id||row.executionId===trace.upload_id);
  if(existing&&!resumable(existing,head))return;
  const source=cases.filter(row=>object(row.directTrajectory)).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')))[0];
  const request=source?.directTrajectory;if(!object(request))unavailable('Frozen auto-watch metadata unavailable');
  const metadata=parse(request.rawAnalysisJson);const selected=metadata.selectedEvaluators;
  if(!Array.isArray(selected)||!selected.length||selected.some(id=>typeof id!=='string'||!id))unavailable('Frozen auto-watch evaluator slots unavailable');
  const available=JSON.parse(String(head.evaluatorIdsJson||'[]')) as unknown;
  const slots=selected.map(id=>'__direct_trajectory__:'+id);
  if(!Array.isArray(available)||slots.some(id=>!available.includes(id)))unavailable('Auto-watch evaluator slots differ from the frozen head');
  const key=createHash('sha256').update(JSON.stringify([actor.workspace,actor.principal,head.id,trace.task_id])).digest('hex');const caseId='watch-'+key;
  const next:Row={...metadata,autoWatch:true,watchedAgent:head.agentName,autoWatchEnabledAt:head.watchEnabledAt};delete next.watchPlaceholder;delete next.placeholderOnly;
  const timestamp=new Date().toISOString();
  const dto={id:caseId,user:actor.username,evaluatorRunId:head.id,datasetId:request.datasetId||'',caseId:'',executionId:trace.upload_id||null,taskId:trace.task_id,status:'pending',rawAnalysisJson:JSON.stringify(next),createdAt:timestamp,updatedAt:timestamp};
  if(!existing){
   const body={experiment_id:head.id,expected_revision:snapshot.revision,case:{id:caseId,input:'',actualOutput:'',taskId:trace.task_id,executionId:trace.upload_id||null,groupId:caseId,directTrajectory:dto,autoWatchSource:{version:1,watchEnabledAt:head.watchEnabledAt}},only_if_new:true};
   const written=await context.rpc('case_upsert',{...body,operation_key:'auto-watch:'+key,operation_request:{experiment_id:head.id,task_id:trace.task_id,execution_id:trace.upload_id||null,watchEnabledAt:head.watchEnabledAt}}) as {case_id?:string;reused?:boolean};
   if(written.reused)return;if(written.case_id!==caseId)unavailable('Auto-watch Case receipt differs');
  }
  await startCoreExperiment(context,String(head.id),{caseIds:[existing?String(existing.id):caseId],evaluatorIds:slots});await activateExperimentWork(context,String(head.id));
 }
 async function append(context:CoreExperimentContext,actor:CoreBackgroundActor,source:Snapshot,trace:CoreTraceRecord){
  const snapshot=await currentWatch(context,actor,source);if(!snapshot||!completed(trace,actor,snapshot.experiment))return;
  const scope=createHash('sha256').update(JSON.stringify([actor.workspace,actor.principal,snapshot.experiment.id,trace.task_id])).digest('hex');
  const scoped={...context,operationKey:'auto-watch:'+scope};
  await runWithCoreExperimentContext(scoped,async()=>{
   if(snapshot.experiment.scope==='trajectory-direct')return appendDirect(scoped,actor,snapshot,trace);
   const head=snapshot.experiment,cases=Array.isArray(head.cases)?head.cases.filter(object):[];
   const existing=cases.find(row=>row.taskId===trace.task_id||row.executionId===trace.upload_id);if(existing&&!resumable(existing,head))return;
   let id=existing?String(existing.id):'watch-'+scope;
   if(!existing){
    const body={experiment_id:head.id,expected_revision:snapshot.revision,case:{id,input:'',actualOutput:'',taskId:trace.task_id,executionId:trace.upload_id||null,autoWatchSource:{version:1,watchEnabledAt:head.watchEnabledAt}},only_if_new:true};
    const written=await scoped.rpc('case_upsert',{...body,operation_key:'auto-watch:'+scope,operation_request:{experiment_id:head.id,task_id:trace.task_id,execution_id:trace.upload_id||null,watchEnabledAt:head.watchEnabledAt}}) as {case_id?:string;reused?:boolean};
    if(written.reused)return;if(!written.case_id)unavailable('Auto-watch Case receipt unavailable');id=written.case_id;
   }
   const run=await startEvalExperimentCases(String(head.id),[id],actor.username);if(!run)unavailable('Auto-watch RunPlan unavailable');await run.completion;
  });
 }
 async function recover(context:CoreExperimentContext,experimentId:string){
  await Promise.all([
   activateExperimentWork(context,experimentId),
   (async()=>{
    const handle=await context.rpc('claim',{phase:'execute',recovery_only_if_idle:true,experiment_id:experimentId,worker_id:'resume:'+randomUUID(),lease_ms:30000}) as ExperimentWorkHandle|null;if(!handle)return;
    const work=await context.rpc('load_work',handle) as {execution_request?:{kind?:unknown}};
    if(work.execution_request?.kind==='fi')await runCoreFiWork(handle,context);else if(work.execution_request&&(!work.execution_request.kind||work.execution_request.kind==='ordinary'))await runCoreTraceWork(handle,context);else unavailable('Frozen execution worker kind unavailable');
   })(),
  ]);
 }
 async function scanActor(actor:CoreBackgroundActor){
  await withCoreConfiguredExperiments(actor,async()=>{
   const context=requireCoreExperimentContext();
   launch(benchmark,identity(actor,'benchmark-intents'),()=>runWithCoreExperimentContext(context,()=>resumeCoreBenchmarkIntents({limit:1})));
   launch(benchmarkCleanup,identity(actor,'benchmark-cancellations'),()=>runWithCoreExperimentContext(context,async()=>{
    const cursorKey=JSON.stringify([actor.workspace,actor.principal]);let rows:Awaited<ReturnType<typeof readPendingCoreBenchmarkCancellations>>;
    try{rows=await readPendingCoreBenchmarkCancellations(context,20,cancellationCursors.get(cursorKey));}catch(error){if(status(error)===403)return;throw error;}
    if(!rows.length){cancellationCursors.delete(cursorKey);return;}cancellationCursors.set(cursorKey,rows.at(-1)!.id);
    for(const row of rows)try{await reconcileCoreBenchmarkCancellation(context,row.id);}catch(error){if([401,403].includes(status(error)))throw error;issue(error);}
   }));
   const pending=await context.rpc('cancellations',{limit:100,owned_only:true,oldest_first:true}) as Array<{id:string;user?:string}>;
   if(!Array.isArray(pending))unavailable('Complete pending cancellations required');
   for(const item of pending){if(item.user!==actor.principalUsername)continue;if(typeof item.id!=='string')unavailable('Invalid cancellation identity');launch(cleanup,identity(actor,item.id),()=>reconcileCoreCancellation(context,item.id));}
   const snapshots=await context.rpc('list',{limit:2000,_all:true,owned_only:true}) as Snapshot[];
   if(!Array.isArray(snapshots)||snapshots.some(row=>!row?.experiment))unavailable('Complete Experiment heads required');
   const own=snapshots.filter(row=>!row.gold_redacted&&row.experiment.user===actor.principalUsername&&!row.experiment.deletedAt);
   const actorKey=JSON.stringify([actor.workspace,actor.principal]);const plans=observedPlans.get(actorKey)||new Map<string,{runId:string;at:number}>();observedPlans.set(actorKey,plans);
   const running=new Set(own.filter(row=>row.experiment.status==='running').map(row=>String(row.experiment.id)));
   for(const id of plans.keys())if(!running.has(id))plans.delete(id);
   for(const snapshot of own){
    if(snapshot.experiment.status!=='running'||typeof snapshot.current_run_id!=='string')continue;
    const id=String(snapshot.experiment.id),previous=plans.get(id);
    if(!previous||previous.runId!==snapshot.current_run_id){plans.set(id,{runId:snapshot.current_run_id,at:now()});continue;}
    if(now()-previous.at>=30000)launch(active,identity(actor,id)+':resume',()=>snapshot.experiment.scope==='benchmark'?activateExperimentWork(context,id):recover(context,id));
   }
   if(active.size>=concurrency)return;
   const watches=own.filter(row=>row.experiment.scope!=='benchmark'&&row.experiment.watchMode===true&&typeof row.experiment.agentName==='string'&&row.experiment.agentName&&Number.isFinite(Date.parse(String(row.experiment.watchEnabledAt||''))));
   if(!watches.length)return;
   const records=await readCoreExperimentTraces(context,new URLSearchParams({ownership:'user'}));
   const watchStart=(nextWatch.get(actorKey)||0)%watches.length;nextWatch.set(actorKey,(watchStart+1)%watches.length);
   for(let offset=0;offset<watches.length;offset++){
    if(active.size>=concurrency)break;const snapshot=watches[(watchStart+offset)%watches.length];
    const key=identity(actor,String(snapshot.experiment.id));const cursor=cursors.get(key)||'';
    const traces=records.filter(row=>completed(row,actor,snapshot.experiment)&&String(row.upload_id||row.task_id)>cursor).sort((a,b)=>String(a.upload_id||a.task_id).localeCompare(String(b.upload_id||b.task_id))).slice(0,pageSize);
    let visited=0;
    for(const trace of traces){if(active.size>=concurrency)break;visited++;cursors.set(key,String(trace.upload_id||trace.task_id));launch(active,key+':'+String(trace.task_id),()=>append(context,actor,snapshot,trace));}
    if(visited===traces.length&&traces.length<pageSize)cursors.delete(key);
   }
  },options.compatibility);
 }
 async function scan(){
  if(scanning)return;scanning=true;
  try{
   const configured=await configuredCoreBackgroundActors(options.compatibility);
   if(configured.failures.length)issue(Object.assign(new Error('Background credentials unavailable'),{status:configured.failures[0]}));else lastIssue='';
   const actors=configured.actors,start=nextActor%Math.max(1,actors.length);
   const allowed=new Set(actors.map(actor=>JSON.stringify([actor.workspace,actor.principal])));for(const key of observedPlans.keys())if(!allowed.has(key)){observedPlans.delete(key);nextWatch.delete(key);cancellationCursors.delete(key);}
   for(const key of cancellationCursors.keys())if(!allowed.has(key))cancellationCursors.delete(key);
   nextActor=(start+1)%Math.max(1,actors.length);
   for(let offset=0;offset<actors.length;offset++){
    const index=(start+offset)%actors.length;
    try{await scanActor(actors[index]);}catch(error){issue(error);}
   }
  }finally{scanning=false;}
 }
 function start(){if(timer)return;const tick=()=>{void scan().catch(issue);};timer=setInterval(tick,intervalMs);timer.unref();tick();}
 function stop(){if(timer)clearInterval(timer);timer=undefined;}
 return {scan,start,stop,waitForIdle:async()=>{while(active.size||cleanup.size||benchmark.size||benchmarkCleanup.size)await Promise.all([...active.values(),...cleanup.values(),...benchmark.values(),...benchmarkCleanup.values()]);}};
}
const managerKey=Symbol.for('agent-insight.storage-core.experiment-background');
export function startCoreExperimentBackground(){
 const globals=globalThis as unknown as Record<symbol,ReturnType<typeof createCoreExperimentBackground>>;
 globals[managerKey]??=createCoreExperimentBackground();globals[managerKey].start();
}
