import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createIsolatedDatabase} from './helpers/isolated-database';

const isolated=createIsolatedDatabase();
const fixture=String.raw`
import json,os,signal,sys,threading,time,uuid
from pathlib import Path
from urllib.parse import urlsplit
from services.storage.tests.test_collector_sources import CollectorSourceTests
from services.storage.control import SQLiteControlStore
from services.storage.trace_service import TraceRuntime,create_server
report_directory=Path(os.environ['STORAGE_READ_TRANSITION_REPORT_DIR']) if os.environ.get('STORAGE_READ_TRANSITION_REPORT_DIR') else None
class Fixture(CollectorSourceTests):
 def make_control(self):return SQLiteControlStore(report_directory/'core.db',clock=lambda:self.now) if report_directory else super().make_control()
case=Fixture('runTest');case.setUp();directory=Path(sys.argv[1]);stopped=threading.Event();errors=[];lock=threading.Lock();database=None
try:
 if os.environ.get('STORAGE_READ_TRANSITION_CH_CONFIG'):
  from services.storage.clickhouse import ClickHouseStore
  from services.storage.observations import ObservationIngest
  config=json.loads(Path(os.environ['STORAGE_READ_TRANSITION_CH_CONFIG']).read_text());database='read_transition_20261118_'+uuid.uuid4().hex[:12]
  case.facts=ClickHouseStore(**{**config['clickhouse'],'database':database});case.facts.initialize_new_database();case.facts.initialize_analytics_schema();case.facts.initialize_infra_schema();case.facts.initialize_semantic_usage_schema();case.ingest=ObservationIngest(case.control,case.facts)
 key=directory/'controller';key.write_text('d'*64);key.chmod(0o600)
 reader=case.iam.issue_api_credential(case.token,'w',['read'],ttl_ms=86400000)
 baseline=case.snapshot();baseline['session']['query']='original question';baseline['session']['label']='before update'
 case.commit(case.reserve('baseline',legacy_username='alice'),baseline);case.drain()
 runtime=TraceRuntime(case.control,case.facts,cursor_secret=b'isolated-read-transition-cursor',controller_key_file=key)
 server=create_server(runtime,port=0);reply=server.RequestHandlerClass.reply
 def capture(self,status,value,**kwargs):
  if status in (409,503):
   with lock:
    errors.append({'path':urlsplit(self.path).path,'status':status,'code':value.get('code')})
    temporary=directory/'events.tmp';temporary.write_text(json.dumps(errors));temporary.replace(directory/'events.json')
  return reply(self,status,value,**kwargs)
 server.RequestHandlerClass.reply=capture
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 def update():
  try:
   while not (directory/'update').exists():
    if stopped.wait(.01):return
   value=case.snapshot();value['session']['query']='original question';value['session']['label']='after update';value['session']['interactions'][1]['content']='updated answer'
   case.commit(case.reserve('update',legacy_username='alice',raw={'update':True}),value)
   (directory/'pending').write_text('ready')
   while not (directory/'release').exists():
    if stopped.wait(.01):return
   case.drain()
   if report_directory:
    with case.control.read_transaction() as connection:batches=[dict(row) for row in connection.execute('SELECT state,COUNT(*) AS count FROM ingest_batches GROUP BY state')]
    (report_directory/'backend-evidence.json').write_text(json.dumps({'clickhouse_database':database,'batches':batches,'model_invoked':False,'production_changed':False}))
   (directory/'indexed').write_text('ready')
  except Exception as error:(directory/'update-error').write_text(type(error).__name__+':'+str(error))
 updater=threading.Thread(target=update,daemon=True);updater.start()
 with os.fdopen(os.open(directory/'config.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as output:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'token':reader,'controller':str(key)},output)
 signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait();updater.join(timeout=5);server.shutdown();server.server_close();thread.join();runtime.close()
finally:case.doCleanups()
`;

async function until<T>(read:()=>Promise<T|undefined>,message:string):Promise<T>{
 const deadline=Date.now()+20000;
 for(;;){const value=await read();if(value!==undefined)return value;assert.ok(Date.now()<deadline,message);await new Promise(resolve=>setTimeout(resolve,20));}
}

test('original Trace reads wait for an actual committed analysis snapshot to index without returning partial data',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'read-transition-'));
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture,directory],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});
 let stderr='';child.stderr.on('data',value=>stderr=(stderr+String(value)).slice(-6000));const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 const names=['AGENT_INSIGHT_TRACE_STORAGE','AGENT_INSIGHT_STORAGE_CORE_URL','AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE','AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE'];const previous=names.map(name=>process.env[name]);
 try{
  const config=await until(async()=>{try{return JSON.parse(await readFile(path.join(directory,'config.json'),'utf8'));}catch{if(child.exitCode!==null)throw Error(stderr);}},'isolated fixture startup');
  process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL=config.origin;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=config.controller;delete process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE;
  const {GET:data}=await import('@/app/api/observe/data/route');const {GET:session}=await import('@/app/api/observe/session/route');const {GET:reliability}=await import('@/app/api/observe/executions/[executionId]/reliability/route');
  const headers={authorization:'Bearer '+config.token};
  const before=await session(new Request('http://localhost/api/observe/session?taskId=task&view=structure',{headers}));assert.equal(before.status,200,await before.clone().text());assert.equal((await before.json()).label,'before update');
  await writeFile(path.join(directory,'update'),'ready');await until(async()=>{try{return await readFile(path.join(directory,'pending'),'utf8');}catch{}},'committed snapshot readiness');
  const requests=[
   data(new Request('http://localhost/api/observe/data?taskId=task',{headers})),
   session(new Request('http://localhost/api/observe/session?taskId=task&view=structure',{headers})),
   session(new Request('http://localhost/api/observe/session?taskId=task',{headers})),
   reliability(new Request('http://localhost/api/observe/executions/execution/reliability',{headers}),{params:Promise.resolve({executionId:'execution'})}),
  ];
  const events=await until(async()=>{try{const rows=JSON.parse(await readFile(path.join(directory,'events.json'),'utf8')) as Array<{path:string;status:number;code?:string}>;return new Set(rows.map(row=>row.path)).size>=3?rows:undefined;}catch{}},'real source read guards');
  await writeFile(path.join(directory,'release'),'ready');await until(async()=>{try{return await readFile(path.join(directory,'indexed'),'utf8');}catch{}},'index publication');
  const responses=await Promise.all(requests);assert.deepEqual(responses.map(response=>response.status),[200,200,200,200]);
  assert.ok(events.every(event=>event.status===503&&event.code==='TRACE_INDEXING'));
  const values=await Promise.all(responses.map(response=>response.json()));assert.equal(values[0][0].label,'after update');assert.equal(values[1].label,'after update');assert.equal(values[2].label,'after update');assert.ok(values[2].interactions.some((row:any)=>row.content==='updated answer'));assert.equal(values[3].executionId,'execution');
  if(process.env.STORAGE_READ_TRANSITION_REPORT_DIR)await writeFile(path.join(process.env.STORAGE_READ_TRANSITION_REPORT_DIR,'http-evidence.json'),JSON.stringify({passed:true,backend_transitions:events,statuses:responses.map(response=>response.status),updated_label:values[2].label,updated_answer_preserved:true,production_changed:false},null,2));
 }finally{
  if(child.exitCode===null)child.kill('SIGTERM');await exited;
  names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];});
  await rm(directory,{recursive:true,force:true});
 }
});
test.after(async()=>{const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();isolated.dispose();});
