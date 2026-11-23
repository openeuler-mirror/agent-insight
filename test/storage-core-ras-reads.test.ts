import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import test from 'node:test';
import ts from 'typescript';
import {buildRasTaskSummaries,dedupeRasEvents,projectReliabilityTraces} from '../src/lib/ingest/ras/store';
import {createAnalyticsSource} from '../src/lib/storage-core/analytics';
import {buildAnalyticsProjection} from '../src/lib/storage-core/analytics-projection';
const require=createRequire(import.meta.url);
const stamp='2026-11-12T00:00:00Z';
const events=[{id:'event',taskId:'task',type:'anomaly',deliveryId:'delivery',rasSessionKey:null,framework:'opencode',platform:'opencode',anomalyKind:'timeout',severity:'high',summary:'actual timeout',actionTypes:null,payloadJson:'{}',executionId:'execution',user:'alice',ts:new Date(stamp)}];
function load(file:string,deps:Record<string,unknown>){const sandboxModule={exports:{}};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:sandboxModule,exports:sandboxModule.exports,require:(name:string)=>deps[name]??require(name),Response,Request,URL,Date,Map,Set,console:{error(){},warn(){}}});return sandboxModule.exports as Record<string,(request:Request)=>Promise<Response>>;}
function setup(core:boolean,failure?:number,metadata=events){
 let oldReads=0,validated=0;const projection=buildAnalyticsProjection({evidence:{snapshot_hash:'a'.repeat(64),execution:{id:'execution',taskId:'task',user:'alice',timestamp:stamp,query:'request',framework:'opencode',agentName:'A'},session:{startTime:stamp,endTime:stamp,label:'label',interactions:[]}}});
 const analytics={...createAnalyticsSource('alice',[{trace_id:'trace',boundary:'boundary',projection}]),actor:{principal:'alice',workspace:'w'},validate:async()=>{validated++;}};
 const raw={events,executionIds:{task:'execution'},actor:{principal:'alice',workspace:'w'},validate:async()=>{validated++;}};
 const old=()=>{oldReads++;};const summary=buildRasTaskSummaries(events);
 const executions=analytics.findMany({where:{isSubagent:false}});
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>core},
  '@/lib/storage-core/analytics':{readCoreAnalytics:async()=>analytics,readCoreRasMetadata:async()=>({actor:raw.actor,rows:metadata,validate:raw.validate}),readCoreRasEvents:async(_request:Request,_tasks:string[],selection:{limit?:number}={})=>{if(failure)throw Object.assign(Error('storage'),{status:failure});return {...raw,events:raw.events.slice(0,selection.limit??raw.events.length)};},analyticsFailure:(error:{status?:number})=>Response.json({error:'storage'},{status:error.status||503})},
  '@/lib/storage-core/compat':{compatibilityFailure:(error:{status?:number})=>Response.json({error:'storage'},{status:error.status||503})},
  '@/lib/auth/auth':{resolveUser:async()=>{old();return{username:'alice'};}},
  '@/lib/ingest/ras/store':{buildRasTaskSummaries,dedupeRasEvents,projectReliabilityTraces,listRasEventsByTaskIds:async(options:{limit?:number})=>{old();return events.slice(0,options.limit??500);},summarizeRasByTaskIds:async()=>{old();return summary;},listAllTasksWithRasEvents:async(options:{limit?:number})=>{old();return options.limit===0?[]:['task'];},findRootExecutionId:async()=>{old();return'execution';},listReliabilityTraces:async(options:{limit?:number})=>{old();return projectReliabilityTraces(executions,events,[{taskId:'task',endTime:new Date(stamp),label:'label'}],summary,options.limit??200);}},
 };
 deps['./analytics']=deps['@/lib/storage-core/analytics'];deps['../ingest/ras/store']=deps['@/lib/ingest/ras/store'];
 if(fs.existsSync('src/lib/storage-core/ras.ts'))deps['@/lib/storage-core/ras']=load('src/lib/storage-core/ras.ts',deps);
 return{GET:load('src/app/api/ingest/ras-events/route.ts',deps).GET,counts:()=>({oldReads,validated})};
}
for(const query of ['?taskId=task','?taskIds=task&summary=1','?summary=1',''])test('RAS GET keeps original DTO without old dynamic reads '+query,async()=>{
 const before=setup(false),after=setup(true);const request=new Request('http://localhost/api/ingest/ras-events'+query);const a=await before.GET(request),b=await after.GET(request);assert.equal(a.status,200);assert.equal(b.status,200);assert.deepEqual(await b.json(),await a.json());assert.equal(after.counts().oldReads,0);assert.ok(after.counts().validated>0);
});

test('RAS summary matches metadata owner after the original global metadata window',async()=>{
 const before=setup(true),after=setup(true,undefined,[{...events[0],id:'bob',user:'bob',platform:'claude'},...events]);
 const request=new Request('http://localhost/api/ingest/ras-events?summary=1');
 assert.deepEqual(await (await after.GET(request)).json(),await (await before.GET(request)).json());
});
test('RAS GET propagates real core authentication and source failures',async()=>{
 for(const status of [401,403,409,503]){const api=setup(true,status);assert.equal((await api.GET(new Request('http://localhost/api/ingest/ras-events?taskId=task'))).status,status);assert.equal(api.counts().oldReads,0);}
});

test('RAS event source carries selected tasks and validates its signed read boundary',async()=>{
 const {readCoreRasEvents}=await import('../src/lib/storage-core/analytics');process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';const actions:string[]=[];
 const fetcher=async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const body=JSON.parse(String(init?.body));actions.push(body.action);
  if(body.action==='ras_read'){assert.deepEqual(body.task_ids,['task']);return Response.json({value:{events,execution_ids:{task:'execution'},scope_fingerprint:'scope',read_token:'signed'}});}
  assert.equal(body.read_token,'signed');return Response.json({value:{scope_fingerprint:'scope'}});
 };
 const result=await readCoreRasEvents(new Request('http://localhost/api/ingest/ras-events',{headers:{authorization:'Bearer api_'+'A'.repeat(43)}}),['task'],{},{fetcher:fetcher as typeof fetch});assert.ok(result.events[0].ts instanceof Date);assert.equal(result.executionIds.task,'execution');await result.validate();assert.deepEqual(actions,['ras_read','validate_ras_read']);
});

for(const query of ['?taskId=task&summary=1&limit=bad','?summary=1&limit=','?limit=0','?taskId=task&limit=0'])test('RAS preserves original branch-specific limit behavior '+query,async()=>{
 const before=setup(false),after=setup(true);const request=new Request('http://localhost/api/ingest/ras-events'+query);const a=await before.GET(request),b=await after.GET(request);assert.equal(a.status,200);assert.equal(b.status,200);assert.deepEqual(await b.json(),await a.json());
});
