import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prisma} from '@/lib/storage/prisma';
import {GET as getExperiment} from '@/app/api/experiments/[id]/route';
import {withCoreExperimentReadRoute} from '@/lib/storage-core/experiments';
import {createExperimentReadView} from '@/lib/storage-core/experiment-view';

test.after(async()=>{await prisma.$disconnect();database.dispose();});

test('real native Trace evidence survives the domain read view and original experiment detail',async()=>{
 const script=`import json
from services.storage.tests.test_experiment_source_lifecycle import ExperimentSourceLifecycleTests
x=ExperimentSourceLifecycleTests();x.setUp()
try:
 item=x.claim();x.call('complete',**x.base.handle(item),result={'score':80},operation_key='native-visible-score')
 print(json.dumps({'view':x.call('read_view',experiment_id='exp'),'baseline':x.call('baseline_view',experiment_id='exp')}))
finally:x.doCleanups()
`;
 const actual=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c',script],{cwd:process.cwd(),encoding:'utf8',timeout:30000}));
 const snapshot=actual.view.snapshots[0];assert.ok(snapshot.sessions[0].interactions);assert.equal(snapshot.executions.length,1);
 const source=createExperimentReadView(actual.view.snapshots);
 const trace=snapshot.executions[0].taskId;
 const roots=await source.execution.findMany({where:{user:'bob',taskId:trace,isSubagent:false},orderBy:{timestamp:'desc'},select:{id:true,taskId:true,query:true,finalResult:true,agentName:true,model:true}});
 assert.equal(roots.length,1);assert.equal(roots[0].taskId,trace);
 const fallback=await source.execution.findMany({where:{taskId:trace},select:{id:true,skill:true,executionSkills:{select:{skillName:true,skillVersion:true}}}});assert.equal(fallback.length,1);assert.deepEqual(fallback[0].executionSkills,[]);
 const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const fetcher:typeof fetch=async(url,options)=>{
  const path=new URL(String(url)).pathname;
  if(path==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  if(path==='/v1/compat/evaluators')return Response.json({value:{evaluators:[],releases:[],etag:'"empty"',list_release_id:null}});
  assert.equal(path,'/v1/compat/experiments');const body=JSON.parse(String(options?.body));
  assert.ok(['read_view','baseline_view'].includes(body.action));return Response.json({value:body.action==='baseline_view'?actual.baseline:actual.view});
 };
 try{
  const request=new Request('http://localhost/api/experiments/exp?user=alice',{headers:{authorization:'Bearer api_'+'T'.repeat(43)}});
  const response=await withCoreExperimentReadRoute(request,input=>getExperiment(input,{params:Promise.resolve({id:'exp'})}),{fetcher});
  assert.equal(response.status,200,await response.clone().text());const body=await response.json();assert.equal(body.id,'exp');assert.equal(body.cases[0].input,'问题');assert.equal(body.results.length,1);assert.equal(body.results[0].score,80);
 }finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;}
});

test('historical baseline points are read from the separate authorized baseline view',async()=>{
 const {getExperimentBaselineTrend}=await import('@/lib/engine/experiment/baseline-trend');
 const {runWithCoreExperimentContext}=await import('@/lib/storage-core/experiments');
 const snapshot=(id:string,date:string,score:number)=>({coverage:'complete',experiment:{id,name:id,type:'single',user:'alice',agentName:'agent',status:'done',scope:'',preset:null,watchMode:false,evaluatorIdsJson:'["judge"]',configSnapshotJson:JSON.stringify({datasetId:'dataset',caseIds:['shared']}),createdAt:date,cases:[{id:id+'-case',experimentId:id,input:'same input',datasetInput:null,referenceOutput:'same answer',evaluatorContextJson:null,caseValuesJson:null,faultInjectionType:null,results:[{experimentId:id,caseId:id+'-case',evaluatorId:'judge',status:'done',score,humanScore:null}]}]}});
 const snapshots=[snapshot('current','2026-11-14T00:00:00Z',80),snapshot('prior','2026-11-13T00:00:00Z',60)];
 const calls:string[]=[];
 const value=await runWithCoreExperimentContext({actor:{token:'fixture',workspace:'w',principal:'alice',username:'alice'},request:new Request('http://localhost/api/experiments/current'),options:{},operationKey:'read',body:{},rpc:async(action,payload)=>{calls.push(action);assert.equal(action,'baseline_view');assert.equal(payload?.experiment_id,'current');return {coverage:'complete',snapshots};}},()=>getExperimentBaselineTrend({experimentId:'current',user:'alice'}));
 assert.deepEqual(calls,['baseline_view']);assert.deepEqual(value?.points.map(point=>[point.experimentId,point.value]),[['prior',60],['current',80]]);
});
