import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
const fixture=String.raw`
import json,os,signal,sys,threading
from pathlib import Path
from services.storage.tests.test_collector_sources import CollectorSourceTests,CurrentFacts
from services.storage.tests.test_semantic_usage import SemanticFacts
from services.storage.trace_service import TraceRuntime,create_server
class Facts(CurrentFacts,SemanticFacts):
 def __init__(self):CurrentFacts.__init__(self);SemanticFacts.__init__(self)
case=CollectorSourceTests('runTest');case.setUp()
try:
 facts=Facts();case.facts=facts;case.ingest.facts=facts;case.queries.facts=facts;case.authorized.facts=facts
 receipt=case.service().reserve(case.api,'w',case.body(legacy_username='alice'));snapshot=case.snapshot();snapshot['execution']['rootExecutionId']=None;case.commit(receipt,snapshot);case.drain()
 key=Path(case.tmp.name)/'controller';key.write_text('c'*64);key.chmod(0o600)
 runtime=TraceRuntime(case.control,facts,cursor_secret=b'semantic-usage-isolated-http-cursor',default_workspace='w',controller_key_file=key)
 server=create_server(runtime,port=0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 tokens={name:case.iam.issue_api_credential(case.tokens[name],'w',['read','write','delete']) for name in ('alice','bob','admin')}
 tokens['readonly']=case.iam.issue_api_credential(case.token,'w',['read'])
 with os.fdopen(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'controller':str(key),**tokens},out)
 stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait();server.shutdown();server.server_close();thread.join();runtime.close()
finally:case.doCleanups()
`;
test('original GoalPlus, collaboration and mixed-owner Usage handlers use scoped new storage without legacy rows',async()=>{
 const old={...process.env},dir=await mkdtemp(path.join(os.tmpdir(),'core-semantic-wire-')),file=path.join(dir,'private.json');const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture,file],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',v=>stderr=(stderr+v).slice(-8192));const exited=new Promise<void>(r=>child.once('exit',()=>r()));
 try{
  let settings:any;const deadline=Date.now()+30000;while(!settings){try{settings=JSON.parse(await readFile(file,'utf8'));}catch{if(child.exitCode!==null)throw Error(stderr);assert.ok(Date.now()<deadline,'fixture startup');await new Promise(r=>setTimeout(r,20));}}
  process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL=settings.origin;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=settings.controller;delete process.env.AGENT_INSIGHT_USAGE_ENABLED;
  const req=(route:string,method='GET',body?:unknown,token=settings.alice)=>new Request('http://isolated'+route,{method,headers:{...(token?{'x-witty-api-key':token}:{}),...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const {goalPlusSnapshotId}=await import('@/lib/ingest/goal-plus/contracts'),ingest=await import('@/app/api/ingest/goal-plus/v1/snapshots/route'),goals=await import('@/app/api/observe/goal-plus/goals/route'),goal=await import('@/app/api/observe/goal-plus/goals/[goalId]/route');
  const sourceId='source-1',contentHash='sha256:'+'a'.repeat(64),snapshot={format:'agent-insight.goal-plus-snapshot',version:1,snapshotId:goalPlusSnapshotId(sourceId,'goal','goal-1',contentHash),sourceId,kind:'goal',objectKey:'goal-1',parentKeys:{goalId:'goal-1'},sourceSchemaVersion:1,contentHash,observedAt:'2026-11-17T00:00:00.000Z',payload:{goalPlusId:'goal-1',status:'active',boundedGoal:'preserve original semantics',activeSession:{host:'pi-agent',sessionId:'task'}},redaction:{contentMode:'bounded',truncatedFields:[],removedFields:[]}},batch={format:'agent-insight.goal-plus-batch',version:1,source:{sourceId,workspaceFingerprint:'sha256:'+'b'.repeat(64),collectorVersion:'fixture'},snapshots:[snapshot]};
  let response=await ingest.POST(req('/api/ingest/goal-plus/v1/snapshots','POST',batch));assert.equal(response.status,200,(await response.clone().text())+stderr);assert.equal((await response.json()).accepted,1);
  response=await ingest.POST(req('/api/ingest/goal-plus/v1/snapshots','POST',batch));assert.equal((await response.json()).duplicate,1);
  response=await goals.GET(req('/api/observe/goal-plus/goals'));assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).goals[0].goalPlusId,'goal-1');
  response=await goals.GET(req('/api/observe/goal-plus/goals','GET',undefined,settings.bob));assert.deepEqual((await response.json()).goals,[]);
  response=await goals.GET(req('/api/observe/goal-plus/goals?user=alice','GET',undefined,settings.admin));assert.equal(response.status,200);assert.equal((await response.json()).goals.length,1);
  response=await goals.GET(req('/api/observe/goal-plus/goals?user=alice','GET',undefined,settings.bob));assert.equal(response.status,403);
  response=await ingest.POST(req('/api/ingest/goal-plus/v1/snapshots','POST',batch,settings.readonly));assert.equal(response.status,403);
  response=await goal.GET(req('/api/observe/goal-plus/goals/goal-1?sourceId=source-1'),{params:Promise.resolve({goalId:'goal-1'})});assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).goal.boundedGoal,'preserve original semantics');
  response=await ingest.POST(req('/api/ingest/goal-plus/v1/snapshots','POST',{...batch,source:{...batch.source,workspaceFingerprint:'sha256:'+'c'.repeat(64)}}));assert.equal(response.status,409);
  const makeSnapshot=(kind:any,key:string,payload:any,parentKeys:any,index:number)=>{const hash='sha256:'+String(index).repeat(64);return {...snapshot,kind,objectKey:key,parentKeys,payload,contentHash:hash,snapshotId:goalPlusSnapshotId(sourceId,kind,key,hash)};};
  const children=[makeSnapshot('run','run-1',{runId:'run-1',state:'searching'},{goalId:'goal-1',runId:'run-1'},1),makeSnapshot('candidate','candidate-1',{candidateId:'candidate-1',iterations:[{iteration:1,score:0,processPassed:false,summary:'original candidate'}]},{runId:'run-1',candidateId:'candidate-1'},2),makeSnapshot('agent_session','worker-1',{agentSessionId:'worker-1',host:'pi-agent',nativeSessionId:'task',role:'candidate-worker'},{runId:'run-1',candidateId:'candidate-1',agentSessionId:'worker-1'},3)];
  response=await ingest.POST(req('/api/ingest/goal-plus/v1/snapshots','POST',{...batch,snapshots:children}));assert.equal(response.status,200,await response.clone().text());const childResult=await response.json();assert.equal(childResult.accepted,3,JSON.stringify(childResult));assert.ok(childResult.correlation.linked>=1,JSON.stringify(childResult));
  response=await goal.GET(req('/api/observe/goal-plus/goals/goal-1?sourceId=source-1'),{params:Promise.resolve({goalId:'goal-1'})});const expanded=(await response.json()).goal;assert.equal(expanded.runs[0].candidates[0].iterations[0].score,0);assert.equal(expanded.runs[0].agentSessions[0].nativeSessionId,'task');assert.equal(expanded.links[0].execution.id,'execution');
  const collab=await import('@/lib/collaboration/runtime');const event={collaborationId:'group-1',eventId:'event-1',fromSessionId:'parent',toSessionId:'child',description:'original relation'};
  response=await collab.collaborationHandlers.report(req('/api/ingest/collaborations/events','POST',event));assert.equal(response.status,201,await response.clone().text());
  response=await collab.collaborationHandlers.report(req('/api/ingest/collaborations/events','POST',event));assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).result,'duplicate');
  response=await collab.collaborationHandlers.bind(req('/api/ingest/collaborations/sessions','POST',{collaborationId:'group-1',sessionId:'parent',traceSessionId:'not-yet-arrived',eventClock:'unknown'}));assert.equal(response.status,201,await response.clone().text());
  response=await collab.collaborationHandlers.graph(req('/api/observe/collaborations/group-1'),'group-1');assert.equal(response.status,200,await response.clone().text());assert.equal((await response.json()).total,1);
  const usage=await import('@/app/api/usage/events/route'),summary=await import('@/app/api/admin/usage/summary/route'),access=await import('@/app/api/admin/usage/access/route');
  assert.equal((await usage.POST(req('/api/usage/events','POST',{},''))).status,202);process.env.AGENT_INSIGHT_USAGE_ENABLED='1';
  const first={eventId:'shared-owner-event',featureKey:'trace',eventKey:'trace.detail.view',occurredAt:'2026-11-17T01:00:00.000Z'};
  response=await usage.POST(req('/api/usage/events','POST',{user:'forged-admin',events:[first,first]}));assert.equal(response.status,202);assert.equal((await response.json()).accepted,2);
  response=await usage.POST(req('/api/usage/events','POST',{events:[first]},settings.bob));assert.equal(response.status,202);
  const transfer=await import('@/app/api/observe/traces/export/route');response=await transfer.GET(req('/api/observe/traces/export?executionId=execution'));assert.equal(response.status,200,await response.clone().text());
  const {getUsageQueue}=await import('@/lib/usage-analytics/queue');await getUsageQueue()!.drain();await getUsageQueue()!.settle();assert.equal(getUsageQueue()!.stats().flushed,3);
  const {withSemanticRequest,semanticRpc}=await import('@/lib/storage-core/semantic-sources');await withSemanticRequest(req('/api/admin/usage/summary','GET',undefined,settings.admin),async()=>{const rows=await semanticRpc<any[]>('usage_daily',{to:'2026-11-17'});assert.deepEqual(rows.filter(row=>row.eventKey==='trace.detail.view').map(row=>[row.user,row.count]).sort(),[['alice',1],['bob',1]]);assert.equal(rows.find(row=>row.eventKey==='trace.export').count,1);});
  response=await access.GET(req('/api/admin/usage/access','GET',undefined,settings.bob));assert.equal((await response.json()).isAdmin,false);response=await access.GET(req('/api/admin/usage/access','GET',undefined,settings.admin));assert.equal((await response.json()).isAdmin,true);
  response=await summary.GET(req('/api/admin/usage/summary','GET',undefined,settings.bob));assert.equal(response.status,403);
  const {prismaRaw}=await import('@/lib/storage/prisma');assert.equal(await prismaRaw.goalPlusSource.count(),0);assert.equal(await prismaRaw.collaboration.count(),0);assert.equal(await prismaRaw.platformUsageEvent.count(),0);delete process.env.AGENT_INSIGHT_TRACE_STORAGE;const {persistGoalPlusBatch}=await import('@/lib/ingest/goal-plus/persist');const legacyResult=await persistGoalPlusBatch('isolated-legacy-fallback',batch as import('@/lib/ingest/goal-plus/contracts').GoalPlusBatchV1);assert.equal(legacyResult.accepted,1);assert.equal(await prismaRaw.goalPlusSource.count(),1);await prismaRaw.$disconnect();
 }finally{if(child.exitCode===null)child.kill('SIGTERM');await exited;for(const key of Object.keys(process.env))if(!(key in old))delete process.env[key];Object.assign(process.env,old);}
});
test.after(()=>database.dispose({preserveFiles:true}));


test('mixed-owner partial usage persistence retries only pending owners and retains successful flush counts',async()=>{
 const {UsageQueue}=await import('@/lib/usage-analytics/queue'),{UsagePersistError}=await import('@/lib/usage-analytics/types');
 const alice={eventId:'one',occurredAt:new Date(),dateKey:'2026-11-17',user:'alice',featureKey:'trace',eventKey:'trace.detail.view',source:'client' as const},bob={...alice,eventId:'two',user:'bob'};let calls=0;
 const storage={persistBatch:async(events:any[])=>{calls++;if(calls===1){assert.deepEqual(events,[alice,bob]);throw new UsagePersistError(1,[bob]);}assert.deepEqual(events,[bob]);return 1;},queryDaily:async()=>[],earliestDateKey:async()=>null,cleanupRawBefore:async()=>0};
 const queue=new UsageQueue(storage);queue.enqueue(alice);queue.enqueue(bob);await queue.flush();assert.equal(queue.stats().flushed,1);assert.equal(queue.depth,1);await queue.flush();assert.equal(queue.stats().flushed,2);assert.equal(queue.depth,0);assert.equal(queue.stats().dropped,0);
});
