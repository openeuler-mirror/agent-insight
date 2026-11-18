import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {activateIsolatedHome} from './helpers/isolated-home';
const fixture=String.raw`
import copy,hashlib,json,os,signal,sys,threading,time
from pathlib import Path
from services.storage.tests.test_experiments import ExperimentTests,experiment
from services.storage.tests.test_trace_service import QueryFacts
from services.storage.trace_service import TraceRuntime,create_server
from services.storage.platform_controls import PlatformControls
from services.storage.legacy_history import INERT_SOURCE,control_history_key,HISTORY_FENCE_VERSION
case=ExperimentTests('runTest');case.setUp()
try:
 case.control.clock=lambda:int(time.time()*1000);case.iam.clock=case.control.clock;case.token=case.iam.issue_session_for_provisioning('alice');store=case.service()
 for identity in ('historical','live'):
  value=experiment();value['id']=identity;value['cases'][0]['id']=identity+'-case';store.dispatch('create',case.token,'w',{'experiment':value,'operation_key':'create-'+identity})
  data={'id':'cancel-'+identity,'experimentId':identity,'caseKey':'','user':'alice','status':'pending','revision':'1','targetsJson':json.dumps([{'kind':'ordinary','runId':identity+'-target','clientId':'client','confirmed':False}]),'createdAt':'2026-11-18T00:00:00.000Z','updatedAt':'2026-11-18T00:00:00.000Z'}
  digest,ref=store._put(data)
  with case.control.transaction() as con:con.execute('INSERT INTO experiment_annotations(workspace_id,experiment_id,annotation_id,kind,actor_principal_id,payload_hash,payload_ref,created_at_ms) VALUES(?,?,?,?,?,?,?,?)',('w',identity,data['id'],'cancellation','alice',digest,ref,case.control.clock()))
 with case.control.transaction() as con:con.execute('INSERT INTO inbox_receipts VALUES(?,?,?,?,?)',('w',INERT_SOURCE,control_history_key('experiment','historical'),'a'*64,case.control.clock()))
 device='dc_'+'j'*43
 PlatformControls(case.control).dispatch(case.token,'w','records_batch',{'legacy_username':'alice','operation_key':'current-device','operations':[{'kind':'reliabilityClient','method':'create','data':{'id':'client','clientId':'client','user':'alice','name':'Current Device','lastSeenAt':'2026-11-18T00:00:00.000Z'}},{'kind':'reliabilityClientCredential','method':'create','data':{'id':'credential','clientId':'client','credentialHash':hashlib.sha256(device.encode()).hexdigest()}}]},trusted=True)
 key=Path(case.tmp.name)/'controller';key.write_text('d'*64);key.chmod(0o600)
 runtime=TraceRuntime(case.control,QueryFacts(),cursor_secret=b'isolated-history-cancellation-cursor',controller_key_file=key)
 server=create_server(runtime,port=0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 with os.fdopen(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as stream:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'controller':str(key),'token':case.token,'device':device,'fenceVersion':HISTORY_FENCE_VERSION},stream)
 stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set());stopped.wait();server.shutdown();server.server_close();thread.join();runtime.close()
finally:case.doCleanups()
`;
test('historical pending cancellation stays readable and creates no pollable command before any later update fence',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'history-cancellation-')),restore=activateIsolatedHome(directory),file=path.join(directory,'fixture.json');
 const child=spawn(process.env.PYTHON||'python3',['-u','-c',fixture,file],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',value=>stderr=(stderr+String(value)).slice(-6000));const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
 try{
  let config:any;const deadline=Date.now()+20000;while(!config){try{config=JSON.parse(await readFile(file,'utf8'));}catch{if(child.exitCode!==null)throw Error(stderr);assert.ok(Date.now()<deadline,'fixture startup');await new Promise(resolve=>setTimeout(resolve,20));}}
  assert.equal(config.fenceVersion,0);process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL=config.origin;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=config.controller;
  const {withCoreExperiments,requireCoreExperimentContext}=await import('@/lib/storage-core/experiments');const {reconcileCoreCancellation,registerCoreCancellationContext,sweepCoreCancellations}=await import('@/lib/storage-core/experiment-cancellation');const {controlClient}=await import('@/lib/storage-core/control-repository');
  await withCoreExperiments(new Request('http://localhost/cancellations',{headers:{authorization:'Bearer '+config.token}}),async()=>{
   const context=requireCoreExperimentContext();await assert.rejects(reconcileCoreCancellation(context,'cancel-historical'),(error:any)=>error.status===409);
   assert.equal(await controlClient.reliabilityCommand.count(),0,'historical reconciliation must reject before command creation');
   const historical=await context.rpc('cancellation_lookup',{cancellation_id:'cancel-historical'}) as any;assert.equal(historical.status,'pending');assert.equal(historical.historical_inert,true);assert.equal(JSON.parse(historical.targetsJson)[0].commandId,undefined);
   await assert.rejects(context.rpc('cancellation_route',{cancellation_id:'cancel-historical'}),(error:any)=>error.status===409);
   const forbidden=async()=>{assert.fail('Historical cancellation called an execution dependency');};const read=await reconcileCoreCancellation(context,'cancel-historical',{getCommand:forbidden,newCommandId:()=>{assert.fail('Historical command ID allocated');},createCommand:forbidden,dispatch:forbidden,stopFi:forbidden,stopLocal:forbidden});assert.equal(read.status,'pending');
   const pending=await context.rpc('cancellations',{owned_only:true}) as any[];assert.deepEqual(pending.map(row=>row.id),['cancel-live']);registerCoreCancellationContext(context);await sweepCoreCancellations();
   const commands=await controlClient.reliabilityCommand.findMany();assert.equal(commands.length,1);assert.equal(JSON.parse(commands[0].payloadJson).runId,'live-target');assert.equal(commands[0].status,'CREATED');
   const after=await context.rpc('cancellation_lookup',{cancellation_id:'cancel-historical'}) as any;assert.equal(after.targetsJson,historical.targetsJson);assert.equal(after.status,'pending');
  });
  const {GET:poll}=await import('@/app/api/reliability/client/v1/commands/next/route');const claimed=await poll(new Request('http://localhost/api/reliability/client/v1/commands/next?waitSeconds=2',{headers:{authorization:'Bearer '+config.device,'x-agent-insight-client-id':'client'}}));assert.equal(claimed.status,200);assert.equal((await claimed.json()).payload.runId,'live-target');
 }finally{const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();if(child.exitCode===null)child.kill('SIGTERM');await exited;restore();await rm(directory,{recursive:true,force:true});}
});
