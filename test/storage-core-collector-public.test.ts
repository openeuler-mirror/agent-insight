import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
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
    key=Path(case.tmp.name)/'controller';key.write_text('b'*64);key.chmod(0o600)
    token=case.iam.issue_api_credential(case.token,'w',['read','write'],ttl_ms=86400000)
    executor=case.iam.issue_api_credential(case.token,'w',['read','write','execute'],ttl_ms=86400000)
    runtime=TraceRuntime(case.control,case.facts,cursor_secret=b'isolated-public-collector-cursor',default_workspace='w',controller_key_file=key)
    server=create_server(runtime,port=0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();runtime.start_worker()
    with os.fdopen(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'token':token,'executor':executor,'controller':str(key)},out)
    stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait();server.shutdown();server.server_close();thread.join();runtime.close()
finally:case.doCleanups()
`;
test('public upload, headless completion, proxy CAS and authenticated logs use actual isolated new storage',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'collector-public-'));const config=path.join(directory,'fixture.json');
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture,config],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',value=>{stderr=(stderr+String(value)).slice(-4096);});const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 const names=['AGENT_INSIGHT_TRACE_STORAGE','AGENT_INSIGHT_STORAGE_CORE_URL','AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE','AGENT_INSIGHT_DEFAULT_INGEST_USER','AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE'];const old=names.map(name=>process.env[name]);
 try{
  let settings:any;const deadline=Date.now()+30000;while(!settings){try{settings=JSON.parse(await readFile(config,'utf8'));}catch{if(child.exitCode!==null)throw new Error(stderr);assert.ok(Date.now()<deadline,'startup');await new Promise(resolve=>setTimeout(resolve,20));}}
  process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL=settings.origin;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=settings.controller;delete process.env.AGENT_INSIGHT_DEFAULT_INGEST_USER;
  const {POST:upload}=await import('@/app/api/ingest/upload/route');const {POST:complete}=await import('@/app/api/ingest/opencode/session-complete/route');const {GET:session}=await import('@/app/api/observe/session/route');
  const headers={authorization:'Bearer '+settings.token,'content-type':'application/json'};const req=(url:string,body:any)=>new Request('http://localhost'+url,{method:'POST',headers,body:JSON.stringify(body)});
  const pending=await upload(req('/api/ingest/upload',{task_id:'pending:child',framework:'codex',threadOnly:true,traceThread:{sourceThreadId:'pending-thread',events:[]}}));assert.equal(pending.status,200);
  const result=await upload(req('/api/ingest/upload',{task_id:'public-task',framework:'generic',query:'original query',user:'forged',skip_internal_judgment:true,interactions:[{role:'user',content:'original question',opaque:{z:0,a:null}},{role:'assistant',content:'original answer'}]}));assert.equal(result.status,200,JSON.stringify(await result.clone().json()));assert.equal((await result.json()).upload_id,'public-task');
  const source=await session(new Request('http://localhost/api/observe/session?taskId=public-task',{headers}));assert.equal(source.status,200,JSON.stringify(await source.clone().json()));const value=await source.json();assert.equal(value.user,'alice');assert.ok(value.interactions.some((row:any)=>row.content==='original question'));assert.equal(value.interactions[0].spanId,undefined);
  assert.equal((await complete(req('/api/ingest/opencode/session-complete',{sessionID:'headless',completed_at:'invalid'}))).status,200);const empty=await session(new Request('http://localhost/api/observe/session?taskId=headless',{headers}));assert.equal(empty.status,200);assert.equal((await empty.json()).execution,undefined);
  const {POST:start}=await import('@/app/api/ingest/proxy/[taskId]/start/route');const proxyStart=await start(req('/api/ingest/proxy/proxy-task/start',{user:'forged',query:'"proxy original"',model:'model'}),{params:Promise.resolve({taskId:'proxy-task'})});assert.equal(proxyStart.status,200);assert.equal((await proxyStart.json()).user,'alice');
  const {resolveCollectorRequest,collectorPrivate}=await import('@/lib/storage-core/collector-entry');const {withCoreCollectorIdentity}=await import('@/lib/storage-core/collector-identity');const {addToSession,getSession}=await import('@/lib/ingest/proxy-store');const identity=await resolveCollectorRequest(req('/api/ingest/upload',{}),'snapshot');
  await withCoreCollectorIdentity(identity,async()=>{await Promise.all([addToSession('proxy-task',{requestMessages:[],responseMessage:{content:'one'},usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0},latency:0,timestamp:0,toolCalls:[]}),addToSession('proxy-task',{requestMessages:[],responseMessage:{content:'two'},usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0},latency:0,timestamp:0,toolCalls:[]})]);assert.equal((await getSession('proxy-task'))?.interactions.length,2);});
  const {POST:chat}=await import('@/app/api/ingest/proxy/[taskId]/[...path]/route');assert.equal((await chat(new Request('http://localhost/proxy',{method:'POST',headers:{authorization:'Bearer vendor-secret','content-type':'application/json'},body:'{}'}),{params:Promise.resolve({taskId:'proxy-task',path:['v1','chat','completions']})})).status,401);
  const {saveUserSettings}=await import('@/lib/storage/server-config');const {withCoreControlRequest}=await import('@/lib/storage-core/control-context');await withCoreControlRequest(new Request('http://localhost/settings',{headers:{authorization:'Bearer '+settings.executor}}),()=>saveUserSettings('alice',{activeConfigId:null,configs:[],autoEvaluationEnabled:false}));
  const mapping=path.join(directory,'identities.json');await writeFile(mapping,JSON.stringify({version:1,core_origin:settings.origin,bindings:[{legacy_username:'alice',legacy_api_key_sha256:'c'.repeat(64),principal_id:'alice',workspace_id:'w',credential:settings.executor}]}),{mode:0o600});process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=mapping;
  const {POST:end}=await import('@/app/api/ingest/proxy/[taskId]/end/route');const ended=await end(new Request('http://localhost/api/ingest/proxy/proxy-task/end',{method:'POST',headers:{...headers,authorization:'Bearer '+settings.executor},body:'{}'}),{params:Promise.resolve({taskId:'proxy-task'})});assert.equal(ended.status,200,JSON.stringify(await ended.clone().json()));assert.equal((await ended.json()).summary.task_id,'proxy-task');
  const {POST:logs}=await import('@/app/api/ingest/otel/v1/logs/route');const attr=(key:string,value:string)=>({key,value:{stringValue:value}});const log=(name:string,extra:Record<string,string>)=>({body:{stringValue:'claude_code.'+name},attributes:[attr('event.name',name),attr('event.timestamp','2026-11-17T01:00:00Z'),attr('session.id','authenticated-logs'),attr('prompt.id','p'),...Object.entries(extra).map(([key,value])=>attr(key,value))]});
  const body={resourceLogs:[{resource:{attributes:[attr('service.name','claude-code')]},scopeLogs:[{logRecords:[log('user_prompt',{prompt:'log question','user.id':'forged'}),log('api_response_body',{body:JSON.stringify({role:'assistant',content:[{type:'text',text:'log answer'}]})})]}]}]};const accepted=await logs(req('/api/ingest/otel/v1/logs',body));assert.equal(accepted.status,200,JSON.stringify(await accepted.clone().json()));
  const {drainCoreCollectorLogs}=await import('@/lib/storage-core/collector-logs');for(let i=0;i<30;i++){await drainCoreCollectorLogs();const rows=await collectorPrivate(identity,'query_sessions',{references:['authenticated-logs'],limit:2}).catch((error:any)=>{if(error.status===503)return [];throw error;});if(rows.some((row:any)=>row.session_json&&JSON.parse(row.session_json))){assert.equal(JSON.parse(rows.find((row:any)=>JSON.parse(row.session_json)).session_json).user,'alice');break;}await new Promise(resolve=>setTimeout(resolve,50));if(i===29)assert.fail('Authenticated log source was not persisted');}
 }finally{
  const {stopCoreCollectorWorker}=await import('@/lib/storage-core/collector-worker');stopCoreCollectorWorker();const {stopCoreCollectorLogs}=await import('@/lib/storage-core/collector-logs');stopCoreCollectorLogs();if(child.exitCode===null)child.kill('SIGTERM');await exited;names.forEach((name,index)=>{if(old[index]===undefined)delete process.env[name];else process.env[name]=old[index];});await rm(directory,{recursive:true,force:true});
 }
});
test.after(async()=>{const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();database.dispose();});
