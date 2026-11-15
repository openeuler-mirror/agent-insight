import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {execFileSync} from 'node:child_process';
function load(file:string,deps:Record<string,unknown>){const module={exports:{}};vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,require:(id:string)=>deps[id]??{},console,process,fetch,JSON,Date,Map,Set,URL,URLSearchParams,Request,Response});return module.exports as Record<string,Function>;}
class TagError extends Error{constructor(readonly status:number,message:string){super(message);}}
function fixture(){
 let legacy=0,revoked=false,revokeOnScore=false,reads=0;const actor={username:'old-alice',principal:'alice-id',workspace:'w',token:'token'};
 const tags=[{id:'version',name:'v1',kind:'version',createdBy:'alice',createdAt:'2026-11-14T00:00:00Z'},{id:'foreign-tag',name:'foreign',kind:'version',createdBy:'bob'}];
 const trace={upload_id:'execution',core_trace_id:'canonical-trace',task_id:'task',user:'alice',agentName:'agent',framework:'opencode',timestamp:'2026-11-14T00:00:00Z',trace_completed_at:'2026-11-14T00:00:03Z',query:' Same   question ',tokens:30,latency:3000,cost:0,final_result:'answer',userTags:[tags[0]],is_subagent:false};
 const context={actor,options:{},rpc:async(action:string)=>{assert.equal(action,'list_view');if(revokeOnScore)revoked=true;return {coverage:'complete',snapshots:[{source_available:true,experiment:{user:'alice',cases:[{executionId:'execution',taskId:'task',results:[{id:'result',evaluatorId:'preset-agent-task-completion',status:'done',score:90,humanScore:0,updatedAt:'2026-11-14T00:00:04Z'}]}]}},{source_available:true,experiment:{user:'bob',cases:[{executionId:'execution',taskId:'task',results:[{evaluatorId:'preset-agent-task-completion',status:'done',score:100,humanScore:null,updatedAt:'2026-11-15T00:00:00Z'}]}]}}]};}};
 const api=load('src/lib/version-analysis.ts',{'@/lib/storage/prisma':{prismaRaw:new Proxy({},{get(){legacy++;throw Error('Legacy storage read');}})},'@/lib/trace-tags':{TraceTagError:TagError,ensureTraceTagTables:async()=>{legacy++;throw Error('Legacy DDL');}},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},'@/lib/storage-core/server':{requestCore:async(path:string)=>{if(path==='/v1/auth/me')return {data:{principal_id:actor.principal,username:'alice'}};assert.ok(path.startsWith('/v1/compat/tags?'));return {data:{value:tags}};}},'@/lib/storage-core/experiment-traces':{readCoreExperimentTraces:async()=>{reads++;return revoked?[]:[trace,{...trace,upload_id:'foreign',user:'bob'},{...trace,upload_id:'child',is_subagent:true}];}}});
 return {api,actor,context,get legacy(){return legacy;},revokeDuringScore(){revokeOnScore=true;},get reads(){return reads;}};
}
test('core version analysis preserves aggregation and human zero using only owned new Trace/tag/selected results',async()=>{
 const f=fixture();const value=await f.api.getVersionCompare({user:'old-alice'});assert.equal(value.versions.length,1);assert.equal(value.versions[0].traceCount,1);assert.equal(value.summary.taskCompletionScoreAvg,0);assert.equal(value.summary.avgTokens,30);assert.equal(value.summary.p95LatencySec,3);assert.equal(value.summary.avgCost,0);assert.equal(value.questions[0].key,'Same question');assert.equal(f.legacy,0);
 const detail=await f.api.getVersionTagTraces('version',{user:'old-alice'});assert.equal(detail.total,1);assert.equal(detail.traces[0].taskCompletionScore,0);assert.equal(detail.traces[0].traceStatus,'success');assert.equal(f.legacy,0);
});
test('core version analysis rejects a mismatched direct actor and another owners tag without legacy fallback',async()=>{
 const f=fixture();await assert.rejects(f.api.getVersionCompare({user:'bob'}),(e:unknown)=>(e as {status:number}).status===403);await assert.rejects(f.api.getVersionTagTraces('foreign-tag',{user:'old-alice'}),(e:unknown)=>(e as {status:number}).status===404);assert.equal(f.legacy,0);
});
test('Trace access revoked during score loading is excluded before version analysis returns',async()=>{
 const f=fixture();f.revokeDuringScore();const value=await f.api.getVersionCompare({user:'old-alice'});assert.equal(value.summary.traceCount,0);assert.equal(value.summary.taskCompletionScoreAvg,null);assert.ok(f.reads>=2);assert.equal(f.legacy,0);
});
test('both original version analysis routes compose verified scope and replace spoofed user',async()=>{
 for(const path of ['src/app/api/observe/version-analysis/compare/route.ts','src/app/api/observe/version-analysis/tags/[tagId]/traces/route.ts']){
  let scoped=false;const actor={username:'alice'};const deps={'next/server':{NextResponse:Response},'@/lib/trace-tags':{TraceTagError:TagError},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{withCoreExperiments:async(_req:Request,fn:()=>unknown)=>{scoped=true;return fn();},requireCoreExperimentContext:()=>({actor}),coreExperimentFailure:(e:{status:number})=>Response.json({error:'failed'},{status:e.status||503})},'@/lib/version-analysis':{getVersionCompare:async(input:{user:string})=>{assert.ok(scoped);assert.equal(input.user,'alice');return {ok:true};},getVersionTagTraces:async(_tag:string,input:{user:string})=>{assert.ok(scoped);assert.equal(input.user,'alice');return {ok:true};}}};
  const route=load(path,deps);const response=await route.GET(new Request('http://localhost/api?user=bob'),{params:Promise.resolve({tagId:'version'})});assert.equal(response.status,200);assert.ok(scoped);
 }
});

test('the public Observe proxy never forwards the private canonical identity flag',async()=>{
 const {handleCompatibleObserveData}=await import('../src/lib/storage-core/compat');let observed=false;
 const fetcher:typeof fetch=async(url)=>{const target=new URL(String(url));if(target.pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});assert.equal(target.pathname,'/v1/compat/observe/data');assert.equal(target.searchParams.has('includeCoreIdentity'),false);observed=true;return Response.json({value:[]});};
 const previous=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 try{const response=await handleCompatibleObserveData(new Request('http://localhost/api/observe/data?includeCoreIdentity=1',{headers:{authorization:'Bearer api_'+'A'.repeat(43)}}),{fetcher});assert.equal(response.status,200);assert.ok(observed);}finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous;}
});

test('native core Trace tags and selected machine receipts feed the original version DTO without any legacy rows',async()=>{
 const script=`import json
from services.storage.tests.test_experiment_source_lifecycle import ExperimentSourceLifecycleTests
from services.storage.tests.test_observations import packet
from services.storage.trace_metadata import TraceMetadata
from services.storage.trace_service import TraceQueries
from services.storage.compatibility_list import LegacyTraceList
from services.storage.tests.test_experiments import experiment
x=ExperimentSourceLifecycleTests();x.setUp()
try:
 accepted=x.ingest.accept(x.base.token,'w',packet(trace='b'*32));x.ingest.work_once('native-version-trace');trace=accepted['trace_ids'][0]
 metadata=TraceMetadata(x.control);tag=metadata.create_tag(x.base.token,'w',{'kind':'version','name':'v1'});metadata.add_trace_tags(x.base.token,'w',trace,[tag['id']])
 value=experiment();value.update(id='version-exp',evaluatorIdsJson='["preset-agent-task-completion"]');value['cases'][0].update(id='version-case',executionId=trace,taskId=trace)
 x.call('create',experiment=value,operation_key='version-create');x.call('start',experiment_id='version-exp',frozen_evaluators={'preset-agent-task-completion':{'id':'preset-agent-task-completion'}},operation_key='version-start')
 handle=x.call('claim',experiment_id='version-exp',worker_id='version-worker');proof={key:handle[key] for key in ('attempt_id','fence','lease_owner')};proof['experiment_id']='version-exp'
 x.call('complete',**proof,result={'score':90},operation_key='version-complete');x.call('review',experiment_id='version-exp',result_id=handle['result_id'],human_score=0,human_reason='verified zero',operation_key='version-review')
 queries=TraceQueries(x.control,x.facts,cursor_secret=b'version-analysis-core-cursor');api=LegacyTraceList(queries,metadata)
 before={'tags':metadata.list_tags(x.base.token,'w','version'),'traces':api.read(x.base.token,'w',{'traceUser':'alice','includeCoreIdentity':'1'}),'scores':x.call('list_view')}
 metadata.delete(x.base.token,'w',trace)
 after={'tags':metadata.list_tags(x.base.token,'w','version'),'traces':api.read(x.base.token,'w',{'traceUser':'alice','includeCoreIdentity':'1'}),'scores':x.call('list_view')}
 print(json.dumps({'before':before,'after':after}))
finally:x.doCleanups()
`;
 const actual=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c',script],{cwd:process.cwd(),encoding:'utf8',timeout:30000}));let current=actual.before;let legacy=0;
 const context={actor:{username:'alias-alice',principal:'alice',workspace:'w',token:'native-fixture'},options:{},rpc:async(action:string)=>{assert.equal(action,'list_view');return current.scores;}};
 const api=load('src/lib/version-analysis.ts',{'@/lib/storage/prisma':{prismaRaw:new Proxy({},{get(){legacy++;throw Error('Old row read');}})},'@/lib/trace-tags':{TraceTagError:TagError,ensureTraceTagTables:async()=>{legacy++;throw Error('Old DDL');}},'@/lib/storage-core/mode':{isStorageCoreEnabled:()=>true},'@/lib/storage-core/experiments':{requireCoreExperimentContext:()=>context},'@/lib/storage-core/server':{requestCore:async(path:string)=>({data:path==='/v1/auth/me'?{principal_id:'alice',username:'alice'}:{value:current.tags}})},'@/lib/storage-core/experiment-traces':{readCoreExperimentTraces:async()=>current.traces}});
 assert.notEqual(actual.before.traces[0].upload_id,actual.before.traces[0].core_trace_id);const detail=await api.getVersionTagTraces(actual.before.tags[0].id,{user:'alias-alice'});assert.equal(detail.total,1);assert.equal(detail.traces[0].taskCompletionScore,0);assert.equal(detail.traces[0].traceStatus,'success');
 const summary=await api.getVersionCompare({user:'alias-alice'});assert.equal(summary.summary.traceCount,1);assert.equal(summary.summary.taskCompletionScoreAvg,0);
 current=actual.after;const deleted=await api.getVersionCompare({user:'alias-alice'});assert.equal(deleted.summary.traceCount,0);assert.equal(deleted.summary.taskCompletionScoreAvg,null);assert.equal(legacy,0);
});
