import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {activateIsolatedHome} from './helpers/isolated-home';
const fixture=String.raw`
import hashlib,json,os,signal,sys,threading
from pathlib import Path
from services.storage.tests.test_fault_injection_core import FaultInjectionCoreTests
from services.storage.tests.test_trace_analytics import AnalyticsFacts
from services.storage.trace_service import TraceRuntime,create_server
from services.storage.platform_controls import PlatformControls
case=FaultInjectionCoreTests('runTest');case.setUp()
try:
 case.create();key=Path(case.tmp.name)/'key';key.write_text('a'*64);key.chmod(0o600)
 token=case.iam.issue_api_credential(case.token,'w',['read','write','execute','delete']);readonly=case.iam.issue_api_credential(case.token,'w',['read'])
 controls=PlatformControls(case.control);device='dc_'+'b'*43
 controls.dispatch(token,'w','records_batch',{'legacy_username':'alice','operation_key':'device','operations':[{'kind':'reliabilityClient','method':'create','data':{'id':'client-row','clientId':'client-a','user':'alice','name':'Test','lastSeenAt':'2026-11-17T00:00:00Z'}},{'kind':'reliabilityClientCredential','method':'create','data':{'id':'cred-row','clientId':'client-a','credentialHash':hashlib.sha256(device.encode()).hexdigest()}}]},trusted=True)
 runtime=TraceRuntime(case.control,AnalyticsFacts(),cursor_secret=b'isolated-fi-private-http-cursor',default_workspace='w',controller_key_file=key)
 server=create_server(runtime,port=0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 with os.fdopen(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'controller':str(key),'token':token,'readonly':readonly,'device':device},stream)
 stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait();server.shutdown();server.server_close();thread.join();runtime.close()
finally:case.doCleanups()
`;
test('FI and RAS original HTTP handlers use isolated core storage with API/device/readonly scopes and no legacy tables',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'core-fi-wire-')),restore=activateIsolatedHome(root),file=path.join(root,'private.json');
 const child=spawn('python3',['-u','-c',fixture,file],{cwd:process.cwd(),env:process.env,stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',value=>stderr=(stderr+String(value)).slice(-8192));const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 try{
  let config:any;const deadline=Date.now()+20000;
  while(!config){try{config=JSON.parse(await readFile(file,'utf8'));}catch{if(child.exitCode!==null)throw Error(stderr);assert.ok(Date.now()<deadline,'fixture timeout');await new Promise(resolve=>setTimeout(resolve,20));}}
  process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL=config.origin;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=config.controller;
  const tasks=await import('@/app/api/fault-injection/tasks/route'),detail=await import('@/app/api/fault-injection/task/[taskId]/route'),heartbeat=await import('@/app/api/fault-injection/worker/heartbeat/route'),claim=await import('@/app/api/fault-injection/worker/claim/route'),collect=await import('@/app/api/fault-injection/runs/[runId]/collect-result/route'),stop=await import('@/app/api/fault-injection/tasks/stop/route'),remove=await import('@/app/api/fault-injection/tasks/delete/route'),ras=await import('@/app/api/ingest/ras-events/route');
  const request=(url:string,method='GET',body?:unknown,token=config.token)=>new Request('http://localhost'+url,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.equal((await tasks.GET(request('/api/fault-injection/tasks'))).status,200);
  const item=await (await detail.GET(request('/task'),{params:Promise.resolve({taskId:'task-01234567'})})).json();assert.equal(item.task.runs[0].run_id,'ras-20261117T000000');
  assert.equal((await heartbeat.POST(request('/heartbeat','POST',{workerId:'worker-a'}))).status,200);
  assert.equal((await claim.POST(request('/claim','POST',{workerId:'worker-a'},config.readonly))).status,403);
  const claimed=await (await claim.POST(request('/claim','POST',{workerId:'worker-a'}))).json();assert.equal(claimed.runs.length,1);assert.equal(claimed.runs[0].prompt,'p');assert.equal(typeof claimed.runs[0].claimToken,'string');
  assert.equal((await stop.POST(request('/stop','POST',{taskIds:['task-id']}))).status,200);
  const result=await collect.POST(request('/collect','POST',{taskId:'business',sessionAligned:true,claimToken:claimed.runs[0].claimToken,workerId:'worker-a'}),{params:Promise.resolve({runId:claimed.runs[0].runId})});assert.equal(result.status,200);assert.equal((await result.json()).status,'stopped');
  assert.equal((await remove.POST(request('/delete','POST',{taskIds:['task-id']}))).status,200);
  assert.equal((await heartbeat.POST(request('/heartbeat','POST',{workerId:'forged'},config.device))).status,200);
  const deviceClaim=await claim.POST(request('/claim','POST',{workerId:'forged'},config.device));assert.equal(deviceClaim.status,200);assert.deepEqual((await deviceClaim.json()).runs,[]);
  const rasBody={type:'anomaly',taskId:'ras-only',framework:'opencode',anomaly:{kind:'loop',severity:'warning',summary:'test'},deliveryId:'delivery'};
  const ingested=await ras.POST(request('/api/ingest/ras-events','POST',rasBody));assert.equal(ingested.status,200,JSON.stringify(await ingested.clone().json()));
  assert.equal((await ras.GET(request('/api/ingest/ras-events?taskId=ras-only'))).status,200);
  const deleted=await ras.DELETE(request('/api/ingest/ras-events','DELETE',{taskIds:['ras-only']}));assert.equal(deleted.status,200);assert.equal((await deleted.json()).deleted.ras,1);
  assert.equal((await ras.POST(request('/api/ingest/ras-events','POST',rasBody))).status,409);
  const mapping=path.join(root,'mapping.json');await writeFile(mapping,JSON.stringify({version:1,core_origin:config.origin,bindings:[{legacy_api_key_sha256:'0'.repeat(64),legacy_username:'alice',principal_id:'alice',workspace_id:'w',credential:config.token}]}),{mode:0o600});process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=mapping;process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER='alice';
  const keyless=await ras.POST(new Request('http://localhost/api/ingest/ras-events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...rasBody,taskId:'explicit-demo',user:'forged'})}));assert.equal(keyless.status,200);
  assert.equal((await ras.POST(request('/api/ingest/ras-events','POST',{...rasBody,taskId:'explicit-demo-2'},'api_'+'z'.repeat(43)))).status,401);
 }finally{child.kill('SIGTERM');await exited;restore();}
});
