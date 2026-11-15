import assert from 'node:assert/strict';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prisma} from '@/lib/storage/prisma';
import {withCoreExperiments,withCoreExperimentReadRoute,requireCoreExperimentContext} from '@/lib/storage-core/experiments';
import {createComparisonExperiment,autoPairGroups,getComparisonDetail,rescanComparison} from '@/lib/engine/experiment/comparison-runner';
import {cloneExperimentFromFrozenConfig} from '@/lib/engine/experiment/reuse-config';
import {startCoreExperiment} from '@/lib/storage-core/experiment-assets';

const fixture=String.raw`
import json,os,signal,sys,threading
from services.storage.tests.test_trace_transfer import TraceTransferTests,node,bundle
from services.storage.trace_service import TraceRuntime,create_server
case=TraceTransferTests('runTest');case.setUp()
try:
    for index,model in enumerate(('m1','m2')):
        identity='execution-'+str(index);task='task-'+str(index)
        item=node(identity,task,root=identity)
        item['execution'].update(agentName='comparison-http-agent',model=model,query='same question',skill='frozen-skill',skillVersion=2,skills=['frozen-skill'],invokedSkills=[{'name':'frozen-skill','version':2}],cost=(index+1)*1.25,latency=(index+1)*1111,toolCallCount=index+7,isAnswerCorrect=index==1,finalResult='answer-'+str(index))
        source=bundle([item]);source['rootExecutionId']=identity
        imported=case.transfer.import_bundle(case.token,'w',source);case.drain();case.transfer.mark_completed(case.token,'w',imported)
    runtime=TraceRuntime(case.control,case.facts,cursor_secret=b'isolated-comparison-http-cursor',default_workspace='w')
    server=create_server(runtime,port=0)
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
    with os.fdopen(os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as out:json.dump({'origin':'http://127.0.0.1:'+str(server.server_port),'token':case.token},out)
    stopped=threading.Event();signal.signal(signal.SIGTERM,lambda *_:stopped.set())
    stopped.wait();server.shutdown();server.server_close();worker.join()
finally:case.doCleanups()
`;

test.after(async()=>{await prisma.$disconnect();database.dispose();});
test('real HTTP comparison adapters preserve captured metrics and frozen pair RunPlans on isolated SQLite with fixture facts',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'core-comparison-http-'));const config=path.join(directory,'private.json');
 const python=spawn(process.env.PYTHON||'python3',['-u','-c',fixture,config],{cwd:process.cwd(),stdio:['ignore','ignore','pipe']});let stderr='';python.stderr.on('data',chunk=>{if(stderr.length<8192)stderr+=String(chunk);});
 const exited=new Promise<void>(resolve=>python.once('exit',()=>resolve()));
 const previous={mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};
 try{
  let settings:{origin:string;token:string}|undefined;const deadline=Date.now()+30_000;
  while(!settings){try{settings=JSON.parse(await readFile(config,'utf8'));}catch{if(python.exitCode!==null)throw Error('Comparison fixture failed: '+stderr);if(Date.now()>deadline)throw Error('Comparison fixture startup timed out: '+stderr);await new Promise(resolve=>setTimeout(resolve,20));}}
  process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL=settings.origin;
  const headers={authorization:'Bearer '+settings.token,'content-type':'application/json'};let id='';const before=await prisma.experiment.count();
  await withCoreExperiments(new Request('http://localhost/api/experiments',{method:'POST',headers:{...headers,'idempotency-key':'http-create'},body:'{}'}),async()=>{
   const created=await createComparisonExperiment({user:'alice',name:'HTTP comparison',agentName:'comparison-http-agent',variableDimension:'llm',groups:[{key:'A',value:'m1'},{key:'B',value:'m2'}],evaluatorIds:['preset-agent-trace-quality']});id=created.id;const pairs=await autoPairGroups(id);assert.equal(pairs.length,1);assert.equal(pairs[0].status,'可比');
  });
  await withCoreExperiments(new Request('http://localhost/api/experiments/'+id+'/run',{method:'POST',headers:{...headers,'idempotency-key':'http-run'},body:'{}'}),async()=>{
   const context=requireCoreExperimentContext();await startCoreExperiment(context,id);
   let completed=0;
   for(;;){const handle=await context.rpc('claim',{phase:'evaluate',experiment_id:id,worker_id:'http-fixture'}) as Record<string,unknown>|null;if(!handle)break;const work=await context.rpc('load_work',handle) as {runplan:{experiment_config:{groups:unknown[]}}};assert.equal(work.runplan.experiment_config.groups.length,2);await context.rpc('complete',{...handle,result:{score:completed?85:75,evidence:{md:'fixture scoring, no model invocation'}},operation_key:'http-complete-'+completed});completed++;}
   assert.equal(completed,2);
  });
  const detail=await withCoreExperimentReadRoute(new Request('http://localhost/api/experiments/'+id,{headers}),()=>getComparisonDetail(id,{casePage:1,casePageSize:8}));
  assert.equal(detail.groups.length,2);assert.deepEqual(detail.groups.map(group=>[group.avgCost,group.avgLatency,group.avgSteps,group.successRate]),[[1.25,1111,7,0],[2.5,2222,8,1]]);assert.equal(detail.pairing.items[0].a?.actualOutput,'answer-0');assert.equal(detail.pairing.items[0].b?.actualOutput,'answer-1');assert.equal(detail.progress.done,2);
  await withCoreExperiments(new Request('http://localhost/api/experiments',{method:'POST',headers:{...headers,'idempotency-key':'http-clone'},body:JSON.stringify({sourceExperimentId:id})}),async()=>{const copy=await cloneExperimentFromFrozenConfig({sourceExperimentId:id,user:'alice'});assert.notEqual(copy.id,id);const value=await requireCoreExperimentContext().rpc('read',{experiment_id:copy.id}) as {experiment:{cases:unknown[];sourceExperimentId:string}};assert.equal(value.experiment.cases.length,2);assert.equal(value.experiment.sourceExperimentId,id);});
  await withCoreExperiments(new Request('http://localhost/api/experiments/'+id+'/cases/'+detail.pairing.items[0].a!.caseId,{method:'DELETE',headers:{...headers,'idempotency-key':'http-case-remove'}}),()=>requireCoreExperimentContext().rpc('case_remove',{experiment_id:id,case_id:detail.pairing.items[0].a!.caseId}));
  await withCoreExperiments(new Request('http://localhost/api/experiments/'+id+'/rescan',{method:'POST',headers:{...headers,'idempotency-key':'http-rescan'},body:'{}'}),async()=>{assert.deepEqual(await rescanComparison(id,'alice'),{newPairsCount:0,downgradedPairs:0});const value=await requireCoreExperimentContext().rpc('read',{experiment_id:id}) as {experiment:{cases:unknown[]}};assert.equal(value.experiment.cases.length,1);});
  assert.equal(await prisma.experiment.count(),before);
 }finally{
  if(previous.mode===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous.mode;if(previous.url===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous.url;
  if(python.exitCode===null)python.kill('SIGTERM');await exited;await rm(directory,{recursive:true,force:true});
 }
});
