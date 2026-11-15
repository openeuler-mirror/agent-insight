import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();
import {prisma} from '@/lib/storage/prisma';
import {GET} from '@/app/api/experiments/[id]/route';
import {withCoreExperimentReadRoute,withCoreExperiments} from '@/lib/storage-core/experiments';
import {GET as submissionContent} from '@/app/api/benchmark/v1/artifacts/[artifactId]/content/route';
import {GET as evaluationContent} from '@/app/api/benchmark/v1/evaluations/[evaluationId]/artifacts/[artifactId]/content/route';

test.after(async()=>{await prisma.$disconnect();database.dispose();});
const script=`import json
from services.storage.tests.test_benchmark_core import BenchmarkCoreTests
from services.storage.experiments import ExperimentStore
x=BenchmarkCoreTests();x.setUp()
try:
 import base64,hashlib
 handle,cap,_=x.evaluation();report=b'{"actualScore":80}';sha='sha256:'+hashlib.sha256(report).hexdigest();artifact=x.service().callback('artifact_put',cap,{'job_id':handle['job_id'],'name':'report.json','kind':'official-report','media_type':'application/json','expected_sha256':sha,'bytes_base64':base64.b64encode(report).decode()})
 x.service().callback('progress',cap,{'job_id':handle['job_id'],'progress':{'kind':'evaluation','stage':'running_harness','occurredAt':'2026-11-12T00:00:00Z','progress':{}}})
 raw={'status':'completed','rawResult':{},'evidenceArtifactIds':[artifact['artifactId']],'runtimeFacts':{},'cleanup':{'controller':{'status':'succeeded'}}};accepted=x.service().callback('evaluation_complete',cap,{'job_id':handle['job_id'],'completion':raw});x.service().callback('normalize_commit',cap,{'job_id':handle['job_id'],'raw_completion_hash':accepted['completion_hash'],'normalized':{'status':'done','score':80,'summary':'real detail evidence','points':[],'evidence':{'artifactIds':[artifact['artifactId']]}}})
 bench=x.invoke('read_view',experiment_id='bexp');ids=[a['id'] for run in bench['snapshots'][0]['benchmark_runs'] for a in run['artifacts']+run['evaluations'][0]['artifacts']]
 print(json.dumps({'generic':ExperimentStore(x.control).dispatch('read_view',x.token,'w',{'experiment_id':'bexp'}),'benchmark':bench,'artifacts':{identity:x.invoke('artifact_lookup',artifact_id=identity) for identity in ids}}))
finally:x.doCleanups()
`;

test('original generic Benchmark detail reads the authorized typed runtime projection with complete dates',async()=>{
 const views=JSON.parse(execFileSync(process.env.PYTHON||'python3',['-c',script],{cwd:process.cwd(),encoding:'utf8',timeout:30000}));const calls:string[]=[];const old={mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const fetcher:typeof fetch=async(url,init)=>{const pathname=new URL(String(url)).pathname;if(pathname==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});const body=JSON.parse(String(init?.body));calls.push(pathname+':'+body.action);if(pathname==='/v1/compat/evaluators')return Response.json({value:{evaluators:[],releases:[],etag:'"empty"',list_release_id:null}});if(pathname==='/v1/compat/benchmarks'){if(body.action==='artifact_lookup')return Response.json({value:views.artifacts[body.artifact_id]});assert.equal(body.action,'read_view');assert.equal(body.experiment_id,'bexp');return Response.json({value:views.benchmark});}assert.equal(pathname,'/v1/compat/experiments');return Response.json({value:body.action==='baseline_view'?{coverage:'complete',snapshots:[]}:views.generic});};
 try{const request=new Request('http://localhost/api/experiments/bexp',{headers:{authorization:'Bearer api_'+'B'.repeat(43)}});const response=await withCoreExperimentReadRoute(request,input=>GET(input,{params:Promise.resolve({id:'bexp'})}),{fetcher});assert.equal(response.status,200,await response.clone().text());const detail=await response.json();assert.equal(detail.id,'bexp');assert.equal(detail.cases.length,1);assert.equal(detail.results[0].score,80);const benchmark=detail.cases[0].benchmark;assert.ok(benchmark);assert.ok(benchmark.progressDetails.createdAt);assert.ok(benchmark.progressDetails.finishedAt);assert.ok(benchmark.progressDetails.evaluation.createdAt);assert.ok(benchmark.progressDetails.evaluation.finishedAt);assert.equal(benchmark.progressDetails.evaluation.stage,'running_harness');assert.equal(benchmark.submissions.length,1);assert.equal(benchmark.evidenceArtifacts.length,1);assert.deepEqual(benchmark.publicPayload,{input:'public input'});
 const submission=benchmark.submissions[0];const evidence=benchmark.evidenceArtifacts[0];
 const submissionRequest=new Request('http://localhost'+submission.contentUrl,{headers:request.headers});const submissionResponse=await withCoreExperiments(submissionRequest,()=>submissionContent(submissionRequest,{params:Promise.resolve({artifactId:submission.artifactId})}),{fetcher});assert.equal(submissionResponse.status,200);assert.equal(await submissionResponse.text(),'public submission\n');
 const evaluationId=views.benchmark.snapshots[0].benchmark_runs[0].evaluations[0].id;const evaluationRequest=new Request('http://localhost'+evidence.contentUrl,{headers:request.headers});const evaluationResponse=await withCoreExperiments(evaluationRequest,()=>evaluationContent(evaluationRequest,{params:Promise.resolve({evaluationId,artifactId:evidence.artifactId})}),{fetcher});assert.equal(evaluationResponse.status,200);assert.deepEqual(await evaluationResponse.json(),{actualScore:80});assert.ok(calls.includes('/v1/compat/benchmarks:read_view'));assert.equal(JSON.stringify(detail).includes('PRIVATE GOLD'),false);assert.equal(await prisma.experiment.count(),0);assert.equal(await prisma.benchmarkCaseRun.count(),0);}finally{if(old.mode===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=old.mode;if(old.url===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=old.url;}
});

test('Benchmark detail refuses incomplete typed coverage before invoking the original handler',async()=>{
 const old=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';let handled=false;const calls:string[]=[];
 const fetcher:typeof fetch=async(url,init)=>{const path=new URL(String(url)).pathname;if(path==='/v1/auth/me')return Response.json({principal_id:'alice',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});calls.push(path);const body=JSON.parse(String(init?.body));assert.equal(body.action,'read_view');return Response.json({value:{coverage:'complete',snapshots:[{coverage:'complete',experiment:{id:'bexp',scope:'benchmark'},...(path==='/v1/compat/benchmarks'?{}:{benchmark_runs:[]})}]}});};
 try{await assert.rejects(()=>withCoreExperimentReadRoute(new Request('http://localhost/api/experiments/bexp',{headers:{authorization:'Bearer api_'+'B'.repeat(43)}}),async()=>{handled=true;return Response.json({});},{fetcher}),{status:503});assert.equal(handled,false);assert.deepEqual(calls,['/v1/compat/experiments','/v1/compat/benchmarks']);}finally{if(old===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=old;}
});
