import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
const fixture=String.raw`
import json,os,signal,sys,threading
from pathlib import Path
from services.storage.tests.test_collector_sources import CollectorSourceTests
from services.storage.trace_service import TraceRuntime,create_server
case=CollectorSourceTests('runTest');case.setUp()
try:
    key=Path(case.tmp.name)/'controller';key.write_text('a'*64);key.chmod(0o600)
    runtime=TraceRuntime(case.control,case.facts,cursor_secret=b'isolated-collector-durable-http-cursor',default_workspace='w',controller_key_file=key)
    server=create_server(runtime,port=0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();runtime.start_worker()
    with os.fdopen(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'token':case.api,'controller':str(key)},out)
    stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait();server.shutdown();server.server_close();thread.join();runtime.close()
finally:case.doCleanups()
`;

test('Node JSON representation, frozen preparation and completion survive real private HTTP with SQLite and the observation worker',async()=>{
 assert.ok(existsSync('src/lib/storage-core/collector-durable-preparation.ts'),'durable Node collector transport required');
 const api=await import('@/lib/storage-core/collector-durable-preparation');
 const {resolveCoreCollectorIdentity}=await import('@/lib/storage-core/collector-identity');
 const pure=await import('@/lib/storage-core/collector-preparation');
 const directory=await mkdtemp(path.join(os.tmpdir(),'collector-durable-http-'));const config=path.join(directory,'private.json');
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture,config],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',value=>{stderr=(stderr+String(value)).slice(-8192);});const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 const old={url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL,key:process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE};
 try{
  let settings:{origin:string;token:string;controller:string}|undefined;const deadline=Date.now()+30000;
  while(!settings){try{settings=JSON.parse(await readFile(config,'utf8'));}catch{if(child.exitCode!==null)throw Error('Collector fixture failed: '+stderr);if(Date.now()>deadline)throw Error('Collector startup timed out');await new Promise(resolve=>setTimeout(resolve,20));}}
  process.env.AGENT_INSIGHT_STORAGE_CORE_URL=settings.origin;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=settings.controller;
  const identity=await resolveCoreCollectorIdentity(new Request('http://localhost/api/ingest/upload',{headers:{authorization:'Bearer '+settings.token}}),{operation:'snapshot'});
  const input={data:{task_id:'task',framework:'pi-agent',query:'query',user:'forged',interactions:[{z:0,a:null,role:'user',content:'question',extension:{'扩展':0.4}}]}};
  const reservation={operation_key:'snapshot',task_id:'task',execution_id:'execution',framework:'pi-agent'};
  const begun=await api.beginCoreCollectorPreparation(identity,reservation,input);
  assert.equal(begun.operation_request_json,JSON.stringify(input));
  const captured=await api.captureDurableCoreCollectorPreparation(identity,begun);
  const frozen=JSON.parse(captured.capture_json!);const plan=await pure.prepareCoreCollectorSnapshot(captured.reservation,frozen);
  const sealed=await api.sealCoreCollectorPlan(identity,captured,plan);assert.equal(JSON.parse(sealed.plan_json!).serialized_session_json,JSON.stringify(plan.snapshot!.session));
  const committed=await api.commitCoreCollectorPreparation(identity,sealed);assert.equal(committed.public_ready,false);
  let current=committed;while(current.source_state!=='indexed'){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,30));current=await api.coreCollectorPreparationStatus(identity,sealed);}
  assert.equal((await api.commitCoreCollectorPreparation(identity,sealed)).source_state,'indexed');
  const replay=await api.beginCoreCollectorPreparation(identity,reservation,{data:{interactions:input.data.interactions,user:'forged',query:'query',framework:'pi-agent',task_id:'task'}});
  assert.equal(replay.operation_request_json,JSON.stringify(input));assert.equal(replay.capture_json,captured.capture_json);
  const next=await api.beginCoreCollectorPreparation(identity,{...reservation,operation_key:'next'},input);
  assert.equal(next.prior_session_origin,'node');assert.equal(JSON.stringify(next.reservation.snapshot!.session),JSON.stringify(plan.snapshot!.session));
  await assert.rejects(api.beginCoreCollectorPreparation({...identity},reservation,input),(error:any)=>error.status===403);
  const completeIdentity=await resolveCoreCollectorIdentity(new Request('http://localhost/api/opencode/session-complete',{headers:{authorization:'Bearer '+settings.token}}),{operation:'complete'});
  const empty=await api.beginCoreCollectorPreparation(completeIdentity,{operation_key:'empty',task_id:'empty-task',execution_id:'empty-execution'}, {task_id:'empty-task'});
  const emptyCapture=await api.captureDurableCoreCollectorPreparation(completeIdentity,empty);
  const emptyPlan=pure.prepareCoreCollectorCompletion(emptyCapture.reservation,JSON.parse(emptyCapture.capture_json!));
  const emptySealed=await api.sealCoreCollectorPlan(completeIdentity,emptyCapture,emptyPlan);const done=await api.commitCoreCollectorPreparation(completeIdentity,emptySealed);
  assert.equal(done.source_state,'indexed');assert.equal(done.session!.startTime,new Date(empty.reservation.received_at_ms).toISOString());assert.equal(done.reservation.snapshot,null);
  assert.equal(JSON.stringify(done).includes(settings.token),false);
  const afterEmpty=await api.beginCoreCollectorPreparation(identity,{operation_key:'after-empty',task_id:'empty-task',execution_id:'empty-execution',framework:'opencode'},{data:{task_id:'empty-task',framework:'opencode',interactions:[]}});
  const afterCapture=await api.captureDurableCoreCollectorPreparation(identity,afterEmpty);
  assert.equal(JSON.parse(afterCapture.capture_json!).previous_session.startTime,done.session!.startTime);
  const afterPlan=await api.prepareDurableCoreCollectorPlan(identity,afterCapture);
  assert.equal(JSON.parse(afterPlan.plan_json!).snapshot.session.startTime,done.session!.startTime);
  assert.equal((await api.captureDurableCoreCollectorPreparation(identity,afterCapture)).capture_json,afterCapture.capture_json);
  assert.equal((await api.prepareDurableCoreCollectorPlan(identity,afterPlan)).plan_json,afterPlan.plan_json);
  await api.commitCoreCollectorPreparation(identity,afterPlan);
  const threadInput={data:{threadOnly:true,framework:'codex',traceThread:{sourceThreadId:'durable-thread',metadata:{z:0,a:null},events:[{eventKey:'event',kind:'turn',startedAt:'2026-11-17T00:00:00.000Z',payload:{z:0,a:null}}]}}};
  const threadBegin=await api.beginCoreCollectorPreparation(identity,{operation_key:'thread-only'},threadInput);
  assert.equal(threadBegin.scope_kind,'thread');assert.equal(threadBegin.reservation.trace_id,null);
  const threadCapture=await api.captureDurableCoreCollectorPreparation(identity,threadBegin);
  const threadPlan=await api.prepareDurableCoreCollectorPlan(identity,threadCapture);
  const threadDone=await api.commitCoreCollectorPreparation(identity,threadPlan);assert.equal(threadDone.source_state,'indexed');assert.equal(threadDone.reservation.snapshot,null);
  assert.equal((await api.commitCoreCollectorPreparation(identity,threadPlan)).source_state,'indexed');
  const againInput={data:{...threadInput.data,traceThread:{...threadInput.data.traceThread,events:[{...threadInput.data.traceThread.events[0],status:'done',payload:{z:1,a:null}}]}}};
  const threadAgain=await api.prepareDurableCoreCollectorPlan(identity,await api.captureDurableCoreCollectorPreparation(identity,await api.beginCoreCollectorPreparation(identity,{operation_key:'thread-only-again'},againInput)));
  assert.equal((await api.commitCoreCollectorPreparation(identity,threadAgain)).source_state,'indexed');
  const childGolden=(await import('./fixtures/collector-preparation-golden.json')).default.cases.find((item:any)=>item.children?.length) as any;
  const graphInput={data:structuredClone(childGolden.input)};
  const graphBegin=await api.beginCoreCollectorPreparation(identity,{operation_key:'actual-child-graph',task_id:graphInput.data.task_id,execution_id:graphInput.data.upload_id||graphInput.data.task_id,framework:graphInput.data.framework},graphInput);
  const graphCapture=await api.captureDurableCoreCollectorPreparation(identity,graphBegin);
  const graphPlan=await api.prepareDurableCoreCollectorPlan(identity,graphCapture);const preparedGraph=JSON.parse(graphPlan.plan_json!);assert.ok(preparedGraph.children.length);
  let graphStatus=await api.commitCoreCollectorPreparation(identity,graphPlan);
  while(graphStatus.source_state!=='indexed'){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,30));graphStatus=await api.coreCollectorPreparationStatus(identity,graphPlan);}
  const derivedChild=preparedGraph.children[0];
  const childBegin=await api.beginCoreCollectorPreparation(identity,{operation_key:'independent-child-after-graph',task_id:derivedChild.snapshot.execution.taskId,execution_id:derivedChild.snapshot.execution.id,framework:graphInput.data.framework},{data:{task_id:derivedChild.snapshot.execution.taskId,framework:graphInput.data.framework,interactions:[]}});
  assert.equal(childBegin.prior_session_origin,'node');assert.equal(childBegin.prior_session_json,derivedChild.serialized_session_json);assert.notEqual(childBegin.prior_session_json,preparedGraph.serialized_session_json);
  assert.equal((await api.coreCollectorPreparationStatus(identity,graphPlan)).source_state,'indexed');


 }finally{
  if(child.exitCode===null)child.kill('SIGTERM');await exited;
  for(const [key,value] of [['AGENT_INSIGHT_STORAGE_CORE_URL',old.url],['AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE',old.key]] as const){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await rm(directory,{recursive:true,force:true});
 }
});
test.after(async()=>{const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();database.dispose();});
