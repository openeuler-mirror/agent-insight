import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prisma} from '@/lib/storage/prisma';
import {GET} from '@/app/api/experiments/[id]/route';
import {withCoreExperimentReadRoute} from '@/lib/storage-core/experiments';
import {createExperimentReadView,coreExperimentProjection} from '@/lib/storage-core/experiment-view';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {isFiBusinessTraceUsable} from '@/lib/fault-injection/trace-readiness';

test.after(async()=>{await prisma.$disconnect();database.dispose();});

for(const scope of ['', 'skill-workbench'])test(`native ${scope||'ordinary'} detail retains authorized zero score for a nonowner admin without reading private runtime`,async()=>{
 const script=`import copy,json
from unittest.mock import patch
from services.storage.tests.test_experiments import ExperimentTests,experiment
from services.storage.tests.test_trace_transfer import MemoryFacts
from services.storage.tests.test_observations import packet
from services.storage.observations import ObservationIngest
from services.storage.trace_evidence import TraceEvidence
from services.storage.trace_service import TraceQueries
from services.storage.authorized import AuthorizedStorage
from services.storage.experiments import ExperimentStore
x=ExperimentTests();x.setUp()
try:
 facts=MemoryFacts();ingest=ObservationIngest(x.control,facts);store=ExperimentStore(x.control,evidence=TraceEvidence(TraceQueries(x.control,facts,cursor_secret=b'private-admin-readiness-test'),AuthorizedStorage(x.iam,facts)),frozen_assets_verifier=lambda *_:True)
 value=experiment();value['scope']=${JSON.stringify(scope)};value['preset']='use-case' if value['scope']=='skill-workbench' else None
 store.dispatch('create',x.token,'w',{'experiment':value,'operation_key':'create'});x.execution_start();handle=x.call('claim',experiment_id='exp',phase='execute',worker_id='worker')
 accepted=ingest.accept(x.token,'w',packet());ingest.work_once('ingest-worker');trace=accepted['trace_ids'][0]
 store.dispatch('execute_complete',x.token,'w',x.handle(handle)|{'trace_id':trace,'operation_key':'execute-complete'})
 score=x.claim();store.dispatch('complete',x.token,'w',x.handle(score)|{'result':{'score':0,'evidence':{'json':{'gold':'PRIVATE_GOLD_SENTINEL'}}},'operation_key':'score'})
 output={actor:{'view':store.dispatch('read_view',token,'w',{'experiment_id':'exp'}),'baseline':store.dispatch('baseline_view',token,'w',{'experiment_id':'exp'})} for actor,token in [('alice',x.token),('admin',x.admin)]}
 output['variants']=[];original_plan=store._plan
 for messages,end,agent in [([],True,'agent'),([None],True,'agent'),([{'role':'user','content':'prompt'}],True,'agent'),([{'role':'assistant','content':' '}],True,'agent'),([{'role':'assistant','content':'answer'}],True,'agent'),([{'role':'opencode','parts':[{'type':'tool-call','callID':'real'}]}],True,'agent'),([{'role':'assistant','toolCalls':[{}]}],True,'agent'),([{'role':'assistant','content':'answer'}],False,'agent'),([{'role':'assistant','content':'answer'}],True,'ras-judge'),([{'role':'assistant','content':'answer'}],True,'other')]:
  def changed_plan(*args):
   row,value=original_plan(*args);value=copy.deepcopy(value)
   for evidence in value.get('frozen_trace_evidence',{}).values():evidence['session'].update(interactions=messages,endTime='2026-11-14T00:00:00Z' if end else None);evidence['execution']['agentName']=agent
   return row,value
  with patch.object(store,'_plan',changed_plan):output['variants'].append({'snapshot':store.dispatch('read',x.admin,'w',{'experiment_id':'exp'}),'messages':messages,'end':end,'agent':agent})
 print(json.dumps(output))
finally:x.doCleanups()
`;
 const actual=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c',script],{encoding:'utf8',timeout:30000}));
 const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 try{for(const [actor,username] of [['alice','alice'],['admin','admin'],['alice','legacy-alice']]){
  let snapshot=actual[actor].view.snapshots[0];assert.equal(snapshot.experiment.cases[0].results[0].score,0);
  if(actor==='admin'){assert.equal(snapshot.sessions[0].interactions,null);assert.equal(snapshot.experiment.cases[0].results[0].evidence,null);}
  const fetcher:typeof fetch=async(url,options)=>{
   const path=new URL(String(url)).pathname;
   if(path==='/v1/auth/me')return Response.json({principal_id:actor,username,workspace_id:'w',workspaces:[{workspace_id:'w'}]});
   if(path==='/v1/compat/evaluators')return Response.json({value:{evaluators:[],releases:[],etag:'"empty"',list_release_id:null}});
   assert.equal(path,'/v1/compat/experiments');const action=JSON.parse(String(options?.body)).action;
   assert.ok(['read_view','baseline_view','read'].includes(action));return Response.json({value:action==='baseline_view'?actual[actor].baseline:action==='read'?snapshot:{...actual[actor].view,snapshots:[snapshot]}});
  };
  const request=new Request('http://localhost/api/experiments/exp',{headers:{authorization:'Bearer api_'+'T'.repeat(43)}});
  const response=await withCoreExperimentReadRoute(request,input=>GET(input,{params:Promise.resolve({id:'exp'})}),{fetcher});
  assert.equal(response.status,200,`${actor}: ${await response.clone().text()}`);const body=await response.json();
  assert.equal(body.results.length,1,actor);assert.equal(body.overall,0,actor);assert.equal(body.status,'done',actor);assert.equal(body.progress.done,1,actor);assert.equal(body.traceProgress.ready,1,actor);
  if(actor==='admin'){assert.equal(JSON.stringify(body).includes('PRIVATE_GOLD_SENTINEL'),false);assert.equal(body.cases[0].executionProgress.status,'done');}
  assert.equal(JSON.stringify(body).includes('business_trace_readiness'),false);
  const view=createExperimentReadView([snapshot]);const selected=await view.experiment.findUniqueOrThrow({where:{id:'exp'},select:{id:true,user:true}});
  const metadata=coreExperimentProjection(selected);assert.equal(metadata?.ownerRedacted,actor==='admin');assert.equal(metadata?.traceReadiness[snapshot.experiment.cases[0].id].hasInteractions,true);
  assert.equal(coreExperimentProjection({...selected}),undefined);assert.equal(Object.keys(selected).some(key=>key.includes('readiness')),false);
  if(!scope&&actor==='admin')for(const variant of actual.variants){
   snapshot=variant.snapshot;const item=snapshot.experiment.cases[0];item.fiRunId='fi';snapshot.fi_runs=[{id:'fi',runId:'fi',status:'completed',sessionTaskId:item.taskId,error:null,agent:'agent',platform:'opencode',updatedAt:'2026-11-14T00:00:00Z'}];
   const expected=isFiBusinessTraceUsable({platform:'opencode',agent:'agent',executionAgent:variant.agent,interactions:JSON.stringify(variant.messages),endTime:variant.end?'2026-11-14T00:00:00Z':null});
   const detail=await withCoreExperimentReadRoute(request,input=>GET(input,{params:Promise.resolve({id:'exp'})}),{fetcher});
   assert.equal(detail.status,200,await detail.clone().text());const projected=await detail.json();assert.equal(projected.traceProgress.ready,Number(expected),JSON.stringify(variant));
   assert.equal(projected.overall,expected?0:null);assert.equal(snapshot.sessions[0].interactions,null);
  }
 }}finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;}
});

test('a separate module instance reads only the real view metadata in the same VM',async()=>{
 const code=ts.transpileModule(readFileSync('src/lib/storage-core/experiment-view.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const context=vm.createContext({Date,Map,Set,WeakMap,Symbol,Promise});
 const first=vm.runInContext(`((exports)=>{${code};return exports;})({})`,context);
 const second=vm.runInContext(`((exports)=>{${code};return exports;})({})`,context);
 const view=first.createExperimentReadView([{coverage:'complete',gold_redacted:true,business_trace_readiness:{c:{executionId:'e',taskId:'t',hasInteractions:true,hasBusinessResponse:false,hasEndTime:false,executionAgent:'agent'}},experiment:{id:'exp',cases:[],groups:[],comments:[]}}]);
 const row=await view.experiment.findUnique({where:{id:'exp'},select:{id:true}});
 assert.equal(second.coreExperimentProjection(row)?.ownerRedacted,true);assert.equal(second.coreExperimentProjection(row)?.traceReadiness.c.hasBusinessResponse,false);
 assert.equal(second.coreExperimentProjection({id:'exp',ownerRedacted:true}),undefined);assert.equal(JSON.stringify(row),'{"id":"exp"}');
});
