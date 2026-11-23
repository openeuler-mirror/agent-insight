import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prisma} from './helpers/historical-prisma';
import {GET as listExperiments} from '@/app/api/experiments/route';
import {GET as listRuns} from '@/app/api/experiments/eval-runs/route';
import {GET as listResults} from '@/app/api/experiments/eval-results/route';
import {withCoreExperimentReadRoute} from '@/lib/storage-core/experiments';
import {createExperimentReadView} from '@/lib/storage-core/experiment-view';
test.after(async()=>{await prisma.$disconnect();database.dispose();});

test('native list projection preserves original GET count, human zero and FI status without frozen Session or legacy rows',async()=>{
 const script=`import json
from unittest.mock import patch
from services.storage.tests.test_experiment_list_view import ExperimentListViewTests
from services.storage.tests.test_experiments import experiment
x=ExperimentListViewTests();x.setUp()
try:
 x.base.call('case_upsert',experiment_id='exp',case={'id':'case','taskId':'a'*32,'executionId':x.base.trace},operation_key='task-alias')
 value=experiment();value.update(id='fi',name='FI status');value['cases'][0].update(id='fi-case',fiRunId='actual-fi-id',executionId=None,traceGenerationError='private failure')
 x.base.call('create',experiment=value,operation_key='fi-create')
 x.base.call('start',experiment_id='fi',frozen_evaluators={'judge':{'id':'judge'}},operation_key='fi-start')
 item=x.base.call('claim',experiment_id='fi',worker_id='fi-worker')
 x.base.call('complete',experiment_id='fi',attempt_id=item['attempt_id'],fence=item['fence'],lease_owner=item['lease_owner'],result={'score':75},operation_key='fi-complete')
 failed=experiment();failed.update(id='error-exp',name='Error state');failed['cases'][0].update(id='error-case',taskId='a'*32,executionId=x.base.trace)
 x.base.call('create',experiment=failed,operation_key='error-create')
 x.base.call('start',experiment_id='error-exp',frozen_evaluators={'judge':{'id':'judge'}},operation_key='error-start')
 item=x.base.call('claim',experiment_id='error-exp',worker_id='error-worker')
 x.base.call('fail',experiment_id='error-exp',attempt_id=item['attempt_id'],fence=item['fence'],lease_owner=item['lease_owner'],error={'message':'private-machine-error'},operation_key='error-complete')
 before=x.base.call('read_view')
 original=x.store._plan
 class HiddenSession:
  def __init__(self):self.interactions='x'*(65*1024*1024)
  def __iter__(self):raise AssertionError('Frozen Session must not be traversed')
  def __deepcopy__(self,*_):raise AssertionError('Frozen Session must not be copied')
 def plan(*args,**kwargs):
  row,value=original(*args,**kwargs)
  for evidence in value['frozen_trace_evidence'].values():evidence['session']=HiddenSession()
  return row,value
 with patch.object(x.store,'_plan',side_effect=plan),patch.object(x.store,'_snapshot',side_effect=AssertionError('No full snapshot')):lean=x.call()
 assert len(json.dumps(lean).encode())<65536
 target=x.call(experiment_id='exp');task=x.call(task_id='a'*32);error=x.call(experiment_id='error-exp')
 x.base.revoke();revoked=x.call();revoked_error=x.call(experiment_id='error-exp')
 print(json.dumps({'full':before,'lean':lean,'revoked':revoked,'target':target,'task':task,'error':error,'revoked_error':revoked_error}))
finally:x.doCleanups()
`;
 const native=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c',script],{cwd:process.cwd(),encoding:'utf8',timeout:30000}));
 assert.equal(await prisma.experiment.count(),0);assert.equal(await prisma.execution.count(),0);
 for(const snapshot of native.lean.snapshots){assert.equal(snapshot.projection,'experiment-list/v1');assert.ok(!Object.hasOwn(snapshot,'sessions'));assert.ok(!Object.hasOwn(snapshot,'executions'));}
 const view=createExperimentReadView(native.lean.snapshots);assert.throws(()=>view.session,/incomplete|Unsupported/);assert.throws(()=>view.execution,/incomplete|Unsupported/);
 const before=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 async function render(value:unknown,path='/api/experiments?user=forged',handler=listExperiments){const actions:string[]=[];const response=await withCoreExperimentReadRoute(new Request('http://localhost'+path,{headers:{authorization:'Bearer api_'+'L'.repeat(43)}}),handler,{fetcher:async(url,options)=>{if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});const body=JSON.parse(String(options?.body));if(new URL(String(url)).pathname==='/v1/compat/platform-control'){assert.equal(body.action,'records_read');assert.equal(body.kind,'skillOptimizationRecord');return Response.json({value:{rows:[],scope_revision:'0'}});}actions.push(body.action);assert.equal(body.action,'list_view');const query=new URL('http://localhost'+path).searchParams;if(query.get('runId'))assert.equal(body.experiment_id,query.get('runId'));if(query.get('taskId'))assert.equal(body.task_id,query.get('taskId'));return Response.json({value});}});assert.equal(response.status,200,await response.clone().text());assert.deepEqual(actions,['list_view']);return response.json();}
 try{
  const full=await render(native.full);const lean=await render(native.lean);assert.deepEqual(lean,full);assert.equal(lean.total,3);assert.equal(lean.items.find((item:{id:string})=>item.id==='exp').overallScore,0);assert.equal(lean.items.find((item:{id:string})=>item.id==='fi').status,'partial');
  const revoked=await render(native.revoked);assert.equal(revoked.total,3);assert.equal(revoked.items.find((item:{id:string})=>item.id==='exp').overallScore,null);assert.equal(revoked.items.find((item:{id:string})=>item.id==='fi').overallScore,75);
  const runsPath='/api/experiments/eval-runs?includeRunId=exp';assert.deepEqual(await render(native.lean,runsPath,listRuns),await render(native.full,runsPath,listRuns));
  const resultPath='/api/experiments/eval-results?runId=exp';assert.deepEqual(await render(native.target,resultPath,listResults),await render(native.full,resultPath,listResults));
  const taskPath='/api/experiments/eval-results?taskId='+'a'.repeat(32);assert.deepEqual(await render(native.task,taskPath,listResults),await render(native.full,taskPath,listResults));
  const errorPath='/api/experiments/eval-results?runId=error-exp';const errors=await render(native.error,errorPath,listResults);assert.deepEqual(errors,await render(native.full,errorPath,listResults));assert.equal(errors.results[0].errorMessage,'private-machine-error');const hidden=await render(native.revoked_error,errorPath,listResults);assert.equal(hidden.results[0].errorMessage,null);assert.equal(hidden.results[0].executionId,undefined);
  assert.equal(await prisma.experiment.count(),0);assert.equal(await prisma.execution.count(),0);
 }finally{if(before===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=before;}
});
