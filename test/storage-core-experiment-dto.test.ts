import assert from 'node:assert/strict';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prisma} from '@/lib/storage/prisma';
import {GET as getExperiment} from '@/app/api/experiments/[id]/route';
import {GET as listExperiments} from '@/app/api/experiments/route';
import {withCoreExperimentReadRoute} from '@/lib/storage-core/experiments';
const username='core-experiment-dto-owner';
test.after(async()=>{await prisma.$disconnect();database.dispose();});

test('the original detail and list DTOs are identical when their read source changes to a complete core view',async()=>{
 const exp=await prisma.experiment.create({data:{user:username,name:'原样实验',status:'done',evaluatorIdsJson:JSON.stringify(['preset-result-answer']),cases:{create:[{input:'问题一',actualOutput:'答案一',referenceOutput:'参考一',results:{create:[{experimentId:'placeholder',evaluatorId:'preset-result-answer',status:'done',score:80,humanScore:0,humanReason:'人工校正'}]}}]}},include:{cases:{include:{results:true,traceAttempts:true}},groups:true,comments:true}});
 await prisma.experimentEvalResult.updateMany({where:{caseId:exp.cases[0].id},data:{experimentId:exp.id}});
 const raw=await prisma.experiment.findUniqueOrThrow({where:{id:exp.id},include:{cases:{include:{results:true,traceAttempts:true}},groups:true,comments:true}});
 const request=new Request('http://localhost/api/experiments/'+exp.id+'?user='+username);const params={params:Promise.resolve({id:exp.id})};
 const prior=await getExperiment(request,params);assert.equal(prior.status,200);const expectedDetail=await prior.json();const priorList=await listExperiments(new Request('http://localhost/api/experiments?user='+username));assert.equal(priorList.status,200);const expectedList=await priorList.json();
 await prisma.experiment.delete({where:{id:exp.id}});
 const old=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const snapshot={coverage:'complete',experiment:JSON.parse(JSON.stringify(raw)),executions:[],sessions:[],cancellations:[],local_executions:[],commands:[],fi_runs:[],benchmark_runs:[],grayscale_tasks:[]};
 const fetcher:typeof fetch=async(url)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json({principal_id:'owner',username,workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  if(new URL(String(url)).pathname==='/v1/compat/evaluators')return Response.json({value:{evaluators:[],releases:[],etag:'"evaluators:v1"',list_release_id:'list'}});
  assert.equal(new URL(String(url)).pathname,'/v1/compat/experiments');return Response.json({value:{coverage:'complete',snapshots:[snapshot]}});
 };
 const headers={authorization:'Bearer api_'+'T'.repeat(43)};
 try{
  const detail=await withCoreExperimentReadRoute(new Request(request.url,{headers}),input=>getExperiment(input,params),{fetcher});assert.equal(detail.status,200);assert.deepEqual(await detail.json(),expectedDetail);
  const list=await withCoreExperimentReadRoute(new Request('http://localhost/api/experiments?user=forged',{headers}),listExperiments,{fetcher});assert.equal(list.status,200);assert.deepEqual(await list.json(),expectedList);
 }finally{if(old===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=old;}
});

test('the original create API retains validation and writes a frozen core record without a legacy Experiment row',async()=>{
 const {POST:createExperiment}=await import('@/app/api/experiments/route');const {withCoreExperiments,runWithCoreExperimentContext,requireCoreExperimentContext}=await import('@/lib/storage-core/experiments');
 const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const body={user:'forged',name:'新存储实验创建',agentName:'build',evaluatorIds:['preset-result-answer'],cases:[{input:'完整问题',actualOutput:'完整回答',referenceOutput:'完整参考'}]};
 const request=new Request('http://localhost/api/experiments',{method:'POST',headers:{authorization:'Bearer api_'+'Q'.repeat(43),'content-type':'application/json'},body:JSON.stringify(body)});let created:Record<string,unknown>|undefined;
 const fetcher:typeof fetch=async(url,options)=>{
  const path=new URL(String(url)).pathname;if(path==='/v1/auth/me')return Response.json({principal_id:'owner',username,workspace_id:'w',workspaces:[{workspace_id:'w'}]});
  const payload=JSON.parse(String(options?.body));if(path==='/v1/compat/evaluators')return Response.json({value:payload.action==='freeze'?{schemaVersion:1,cards:{},releases:[],list_etag:'"empty"'}:{evaluators:[],releases:[],etag:'"empty"',list_release_id:null}});
  assert.equal(path,'/v1/compat/experiments');if(payload.action==='lookup_operation')return Response.json({value:{found:false}});assert.equal(payload.action,'create');created=payload.experiment;return Response.json({value:{experiment:{...created,id:'created-core'},revision:'1',lifecycle_revision:'1',etag:'"exp:1"'}});
 };
 const before=await prisma.experiment.count();
 try{
  const response=await withCoreExperiments(request,async()=>{const context=requireCoreExperimentContext();return runWithCoreExperimentContext(context,()=>createExperiment(request));},{fetcher});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{id:'created-core'});assert.equal(created?.user,username);const configuration=JSON.parse(String(created?.configSnapshotJson));assert.equal(configuration.coreAssets.evaluators['preset-result-answer'].origin,'builtin');assert.equal((created?.cases as Array<Record<string,unknown>>)[0].referenceOutput,'完整参考');assert.equal(await prisma.experiment.count(),before);
 }finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;}
});

test('evaluation run/result consumers retain their original DTOs with no legacy result rows',async()=>{
 const {GET:runs}=await import('@/app/api/experiments/eval-runs/route');const {GET:results}=await import('@/app/api/experiments/eval-results/route');
 const exp=await prisma.experiment.create({data:{user:username,name:'历史评测任务',scope:'skill-case-analysis',skillName:'demo',skillVersion:2,status:'done',evaluatorIdsJson:JSON.stringify(['preset-agent-trace-quality']),cases:{create:[{input:'问题',taskId:'historical-task',results:{create:[{experimentId:'placeholder',evaluatorId:'preset-agent-trace-quality',status:'done',score:80,humanScore:0,humanReason:'人工分数零'}]}}]}},include:{cases:{include:{results:true,traceAttempts:true}},groups:true,comments:true}});
 await prisma.experimentEvalResult.updateMany({where:{caseId:exp.cases[0].id},data:{experimentId:exp.id}});
 const raw=await prisma.experiment.findUniqueOrThrow({where:{id:exp.id},include:{cases:{include:{results:true,traceAttempts:true}},groups:true,comments:true}});
 const urls=['http://localhost/api/experiments/eval-runs?user='+username,'http://localhost/api/experiments/eval-results?runId='+exp.id+'&user='+username];const handlers=[runs,results];const expected=[];
 for(let i=0;i<2;i++){const response=await handlers[i](new Request(urls[i]));assert.equal(response.status,200);expected.push(await response.json());}
 await prisma.experiment.delete({where:{id:exp.id}});
 const previous=process.env.AGENT_INSIGHT_TRACE_STORAGE;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const snapshot={coverage:'complete',experiment:JSON.parse(JSON.stringify(raw)),executions:[],sessions:[],cancellations:[]};
 const fetcher:typeof fetch=async(url)=>new URL(String(url)).pathname==='/v1/auth/me'?Response.json({principal_id:'owner',username,workspace_id:'w',workspaces:[{workspace_id:'w'}]}):Response.json({value:{coverage:'complete',snapshots:[snapshot]}});
 try{for(let i=0;i<2;i++){const response=await withCoreExperimentReadRoute(new Request(urls[i],{headers:{authorization:'Bearer api_'+'Q'.repeat(43)}}),handlers[i],{fetcher});assert.equal(response.status,200);assert.deepEqual(await response.json(),expected[i]);}}
 finally{if(previous===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=previous;}
});
