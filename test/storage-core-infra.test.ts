import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
const fixture=String.raw`
import json,os,signal,threading,sys
from pathlib import Path
from services.storage.tests.test_collector_sources import CollectorSourceTests,CurrentFacts
from services.storage.tests.test_infra import InfraFacts
from services.storage.tests.test_trace_analytics import AnalyticsFacts
from services.storage.trace_analytics import TraceAnalytics
from services.storage.trace_service import TraceRuntime,create_server
class CombinedFacts(CurrentFacts,AnalyticsFacts,InfraFacts):
 def __init__(self):AnalyticsFacts.__init__(self);InfraFacts.__init__(self)
case=CollectorSourceTests('runTest');case.setUp();facts=CombinedFacts();case.facts=facts;case.ingest.facts=facts;case.queries.facts=facts;case.authorized.facts=facts
try:
 key=Path(case.tmp.name)/'controller';key.write_text('a'*64);key.chmod(0o600)
 receipt=case.reserve();snapshot=case.snapshot();snapshot['execution']['endpoint']='http://vllm.test:8000';snapshot['execution']['rootExecutionId']=None;case.commit(receipt,snapshot);case.drain()
 analytics=TraceAnalytics(case.queries,case.authorized);prepared=analytics.prepare(case.token,'w',receipt['trace_id']);exe=prepared['evidence']['execution'];row={key:exe.get(key) for key in ('id','taskId','user','timestamp','rootExecutionId','model','latency','outputTokens','agentName','isSubagent')};row.update(executionSkills=[],isAnswerCorrect=None,skill=None,skillVersion=None,skillIssues=None,invokedSkills=None,failures=None)
 analytics.publish(case.token,'w',receipt['trace_id'],prepared['boundary'],{'version':1,'executions':[row],'collaboration':{'candidate':False,'startTime':None,'edges':[]},'errors':[],'provenance':{'snapshot_hash':prepared['evidence']['snapshot_hash']}})
 runtime=TraceRuntime(case.control,facts,cursor_secret=b'isolated-infra-private-http-cursor',default_workspace='w',controller_key_file=key)
 server=create_server(runtime,port=0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();runtime.start_worker()
 tokens={name:case.iam.issue_api_credential(case.tokens[name],'w',['read','write','delete']) for name in ('alice','bob','admin')}
 tokens.update(read_only=case.iam.issue_api_credential(case.token,'w',['read']),write_only=case.iam.issue_api_credential(case.token,'w',['write']))
 with os.fdopen(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'controller':str(key),'session':case.token,**tokens},out)
 stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait();server.shutdown();server.server_close();thread.join();runtime.close()
finally:case.doCleanups()
`;

test('original Infra routes use current IAM and private HTTP with source secrets, pull/push, windows, deletion and best-effort unauthenticated ACK preserved',async()=>{
 const oldEnv={...process.env},originalFetch=globalThis.fetch;
 const root=await mkdtemp(path.join(os.tmpdir(),'infra-core-wire-')),file=path.join(root,'private.json');
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture,file],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',value=>stderr=(stderr+String(value)).slice(-8192));const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 try{
  let settings:any;const deadline=Date.now()+30_000;
  while(!settings){try{settings=JSON.parse(await readFile(file,'utf8'));}catch{if(child.exitCode!==null)throw Error('Infra fixture failed: '+stderr);assert.ok(Date.now()<deadline,'Infra startup timed out');await new Promise(resolve=>setTimeout(resolve,20));}}
  process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL=settings.origin;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=settings.controller;delete process.env.DEFAULT_INGEST_USER;
  const prom=await readFile('test/fixtures/vllm-metrics-sample.txt','utf8'),otlp=await readFile('test/fixtures/vllm-otlp-metrics-sample.json','utf8');let scrapes=0;
  globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:String(input));if(url.origin===settings.origin)return originalFetch(input,init);assert.equal(url.hostname,'vllm.test','only isolated fake metrics endpoint permitted');scrapes++;return new Response(prom);};
  const sources=await import('@/app/api/observe/infra/sources/route'),overview=await import('@/app/api/observe/infra/sources/overview/route'),metrics=await import('@/app/api/ingest/otel/v1/metrics/route'),history=await import('@/app/api/observe/infra/history/route'),poll=await import('@/app/api/observe/infra/poll/route'),exports=await import('@/app/api/observe/infra/export/route'),checks=await import('@/app/api/observe/infra/sources/test/route'),sessions=await import('@/app/api/observe/infra/sources/sessions/route'),derive=await import('@/app/api/observe/infra/sources/derive/route');
  const {coreCookieName}=await import('@/lib/storage-core/server'),store=await import('@/lib/infra/store'),scope=await import('@/lib/storage-core/infra');
  const req=(route:string,method='GET',body?:unknown,token=settings.alice)=>new Request('http://isolated'+route,{method,headers:{...(token?{authorization:'Bearer '+token}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
  const cookie=new Request('http://isolated/api/observe/infra/sources',{method:'POST',headers:{cookie:coreCookieName(settings.origin)+'='+settings.session,'content-type':'application/json'},body:JSON.stringify({endpoint:'http://vllm.test:8000',scrapeUrl:'http://vllm.test:8000/metrics',kind:'pull',model:'configured-model',authHeaders:'Bearer fixture-secret',memBandwidthGBs:0})});
  let response=await sources.POST(cookie);assert.equal(response.status,200);const source=(await response.json()).source;assert.equal(source.auth.hasAuth,true);assert.deepEqual(source.auth.keys,['Authorization']);assert.equal(source.authHeaders,undefined);assert.equal(source.memBandwidthGBs,0);
  const unsigned=await originalFetch(settings.origin+'/v1/compat/infra?workspace_id=w',{method:'POST',headers:{authorization:'Bearer '+settings.alice,'content-type':'application/json'},body:JSON.stringify({action:'list',payload:{}})});assert.equal(unsigned.status,403);
  response=await sources.PATCH(req('/api/observe/infra/sources','PATCH',{id:source.id,model:'changed-model'},settings.read_only));assert.equal(response.status,403);
  response=await sources.GET(req('/api/observe/infra/sources','GET',undefined,settings.bob));assert.deepEqual((await response.json()).sources,[]);
  response=await sources.GET(req('/api/observe/infra/sources','GET',undefined,settings.admin));assert.equal((await response.json()).sources.length,1);
  response=await sources.PATCH(req('/api/observe/infra/sources','PATCH',{id:source.id,enabled:false},settings.admin));assert.equal(response.status,403);
  response=await metrics.POST(req('/api/ingest/otel/v1/metrics','POST',otlp,settings.write_only));assert.equal(response.status,200);assert.equal((await response.json()).attachedTo,source.endpoint);
  const header=new Request('http://isolated/api/observe/infra/history',{headers:{authorization:'Bearer '+settings.alice}});
  await scope.withCoreInfraRequest(header,async()=>{const latest=await store.latestSamples(source.id,5);assert.equal(latest.length,1);const buckets=Object.values(latest[0].histograms)[0].buckets;assert.equal(buckets.at(-1)!.le,Infinity);await store.saveSample(source.id,{...latest[0],tsMs:0.25,source:'vllm-otlp-push',model:'zero',gauges:{zero:0}});const zero=await store.querySamples(source.id,0,1,'zero');assert.equal(zero.length,1);assert.equal(zero[0].tsMs,0.25);return Response.json({ok:true});});
  response=await history.GET(req('/api/observe/infra/history?sourceId='+source.id+'&from=0&to=1&maxPoints=0&model=zero'));const hist=await response.json();assert.equal(hist.count,1);assert.equal(hist.points[0].tsMs,0.25);
  response=await poll.POST(req('/api/observe/infra/poll','POST',undefined,settings.read_only));assert.equal(response.status,403);assert.equal(scrapes,0);
  response=await poll.POST(req('/api/observe/infra/poll','POST'));assert.equal(response.status,200);assert.equal((await response.json()).polled,1);assert.equal(scrapes,1);
  response=await overview.GET(req('/api/observe/infra/sources/overview'));const overviewBody=await response.json();assert.equal(overviewBody.overview[0].source.kind,'pull');assert.equal(overviewBody.overview[0].source.model,'configured-model');assert.equal(overviewBody.overview[0].source.authHeaders,undefined);
  response=await checks.GET(req('/api/observe/infra/sources/test?mode=push&sourceId='+source.id));assert.equal((await response.json()).ok,true);
  response=await exports.GET(req('/api/observe/infra/export?sourceId='+source.id+'&from=0&to='+Date.now()+'&format=csv'));assert.equal(response.status,200);assert.match(response.headers.get('content-type')||'',/text\/csv/);assert.ok((await response.text()).length>100);
  response=await sessions.GET(req('/api/observe/infra/sources/sessions?sourceId='+source.id));assert.equal(response.status,200);assert.equal((await response.json()).total,0);
  response=await derive.GET(req('/api/observe/infra/sources/derive'));const candidates=(await response.json()).candidates;assert.equal(candidates.length,1);assert.equal(candidates[0].endpoint,source.endpoint);assert.equal(candidates[0].registered,true);
  response=await sessions.GET(req('/api/observe/infra/sources/sessions?sourceId='+source.id+'&from=0&to='+Date.now()));const allSessions=await response.json();assert.equal(allSessions.total,1);assert.equal(allSessions.sessions[0].id,'execution');
  const tree=await import('@/app/api/observe/executions/[executionId]/infra/route'),params={params:Promise.resolve({executionId:'execution'})};response=await tree.GET(req('/api/observe/executions/execution/infra'),params);assert.equal(response.status,200);const autoTree=await response.json();assert.equal(autoTree.cards.length,1);assert.equal(autoTree.cards[0].sourceId,source.id);assert.equal(autoTree.manual,false);
  response=await tree.POST(req('/api/observe/executions/execution/infra','POST',{links:[{sourceId:source.id,model:null},{sourceId:source.id,model:null}]}),params);assert.equal(response.status,200);assert.equal((await response.json()).count,2);response=await tree.GET(req('/api/observe/executions/execution/infra'),params);assert.equal((await response.json()).manual,true);response=await tree.POST(req('/api/observe/executions/execution/infra','POST',{links:[]}),params);assert.equal(response.status,200);
  response=await metrics.POST(req('/api/ingest/otel/v1/metrics','POST',otlp,''));assert.equal(response.status,200);assert.equal((await response.json()).attachedTo,null);
  const mapping=path.join(root,'identity.json');await writeFile(mapping,JSON.stringify({version:1,core_origin:settings.origin,bindings:[{legacy_username:'alice',legacy_api_key_sha256:'b'.repeat(64),principal_id:'alice',workspace_id:'w',credential:settings.alice}]}),{mode:0o600});process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=mapping;process.env.DEFAULT_INGEST_USER='alice';
  response=await metrics.POST(req('/api/ingest/otel/v1/metrics','POST',otlp,''));assert.equal((await response.json()).attachedTo,source.endpoint);
  response=await sources.DELETE(req('/api/observe/infra/sources?id='+source.id,'DELETE'));assert.equal((await response.json()).deleted,1);
  response=await history.GET(req('/api/observe/infra/history?sourceId='+source.id));assert.equal((await response.json()).count,0);
  response=await sources.POST(req('/api/observe/infra/sources','POST',{endpoint:source.endpoint}));assert.notEqual((await response.json()).source.id,source.id);
  const {prismaRaw}=await import('./helpers/historical-prisma');assert.equal(await prismaRaw.infraSource.count(),0);assert.equal(await prismaRaw.infraMetricSample.count(),0);await prismaRaw.$disconnect();
 }finally{globalThis.fetch=originalFetch;if(child.exitCode===null)child.kill('SIGTERM');await exited;for(const key of Object.keys(process.env))if(!(key in oldEnv))delete process.env[key];Object.assign(process.env,oldEnv);}
});
test.after(()=>database.dispose({preserveFiles:true}));
