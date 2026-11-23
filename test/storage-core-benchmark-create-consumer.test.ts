import assert from 'node:assert/strict';import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {registerBenchmarkAdapter} from '@/lib/benchmark/adapter-registry';
import {createBenchmarkExperiment} from '@/lib/benchmark/experiment-service';
import {runWithCoreExperimentContext,type CoreExperimentContext} from '@/lib/storage-core/experiments';
import {prisma} from '@/lib/storage/prisma';

const manifest={adapterKey:'core-create-fixture',displayName:'Core Create',requiredCapabilities:[],defaultTimeoutSeconds:30,requiredArtifacts:[],evaluation:{evaluatorKey:'core-create-fixture',defaultTimeoutSeconds:30,defaultResources:{cpu:1,memoryMiB:128}}};
registerBenchmarkAdapter({manifest,buildAgentTask:({publicPayload}: {publicPayload:unknown})=>{assert.deepEqual(publicPayload,{input:'public'});return {};}} as never);

test('Benchmark create consumes public core cases, freezes actual releases, and writes one typed domain operation',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'benchmark-core-create-'));const key=path.join(directory,'controller');await writeFile(key,'a'.repeat(64),{mode:0o600});const previous={mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL,key:process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE};process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=key;
 const token='api_'+'A'.repeat(43);const actor={token,workspace:'w',principal:'p',username:'alice'};const body={name:'Core Benchmark',datasetId:'dataset',clientId:'client',caseSelection:{mode:'all'},runConfig:{platform:'fixture',agent:'build'}};
 const request=new Request('http://localhost/api/experiments',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(body)});const actions:string[]=[];let created:Record<string,unknown>|undefined;let receipt:unknown=null;
 const context:CoreExperimentContext={actor,request,body,operationKey:'create-benchmark',rpc:async()=>{throw Error('ordinary write must not replace Benchmark transaction');},options:{fetcher:async(url,init)=>{
  const pathname=new URL(String(url)).pathname;if(pathname==='/v1/auth/me')return Response.json({principal_id:'p',username:'alice',workspace_id:'w',workspaces:[{workspace_id:'w'}]});const payload=JSON.parse(String(init?.body));actions.push(payload.action);
  if(pathname==='/v1/compat/evaluators')return Response.json({value:{schemaVersion:1,cards:{},releases:[],list_etag:'"empty"'}});
  if(pathname==='/v1/compat/datasets')return Response.json({value:{dataset:{id:'public-dataset',name:'Public Dataset',cases:[],tags:[],fields:[]},revision:'1',lifecycle_revision:'1',release_id:'public-release',etag:'"one"'}});
  if(payload.action==='lookup_operation')return Response.json({value:receipt});
  if(payload.action==='dataset_load')return Response.json({value:{id:'dataset',agentEvalDatasetId:'public-dataset',adapterKey:manifest.adapterKey,status:'ready',contentHash:'sha256:'+'b'.repeat(64),cases:[{id:'dataset-case',ordinal:0,publicPayloadJson:'{"input":"public"}'}],agentEvalDataset:{casesJson:'[{"id":"dataset-case","input":"public"}]'}}});
  assert.equal(payload.action,'create');assert.ok(new Headers(init?.headers).get('x-storage-controller-proof'));created=payload;receipt={id:payload.experiment.id,status:'draft',caseCount:1};return Response.json({value:receipt});
 }}};
 const clientDelegate=prisma.reliabilityClient;const originalClient=clientDelegate.findFirst;clientDelegate.findFirst=(async()=>({clientId:'client',name:'Fixture client',status:'online',serviceHealth:'healthy',lastSeenAt:new Date(),unboundAt:null,capabilitiesJson:JSON.stringify({actions:['RUN_BENCHMARK_CASE'],platforms:[{id:'fixture',agents:['build'],runBenchmarkCase:{returnsTraceId:true}}],components:{'agent-runtime/fixture/v1':{ready:true}}})})) as unknown as typeof originalClient;
 const originalDataset=prisma.benchmarkDataset.findFirst;const originalTransaction=prisma.$transaction;prisma.benchmarkDataset.findFirst=(async()=>{throw Error('legacy Benchmark read');}) as typeof originalDataset;prisma.$transaction=(async()=>{throw Error('legacy Benchmark transaction');}) as typeof originalTransaction;
 try{await runWithCoreExperimentContext(context,async()=>{
  const input={...body,user:'alice',caseSelection:{mode:'all' as const},frozenCustomEvaluators:{schemaVersion:1 as const,cards:{}}};const first=await createBenchmarkExperiment(input);assert.equal(first.status,'draft');assert.ok(created);const experiment=created!.experiment as Record<string,unknown>;const config=JSON.parse(String(experiment.configSnapshotJson));assert.equal(config.coreAssets.releases.dataset,'public-release');assert.equal(config.coreAssets.evaluators['benchmark:core-create-fixture'].origin,'benchmark');assert.equal(created!.dataset_id,'dataset');
  const count=actions.length;assert.deepEqual(await createBenchmarkExperiment({...input,runConfig:{platform:'removed-platform',agent:'removed-agent'}}),first);assert.deepEqual(actions.slice(count),['lookup_operation']);
 });}finally{clientDelegate.findFirst=originalClient;prisma.benchmarkDataset.findFirst=originalDataset;prisma.$transaction=originalTransaction;for(const [name,value] of [['AGENT_INSIGHT_TRACE_STORAGE',previous.mode],['AGENT_INSIGHT_STORAGE_CORE_URL',previous.url],['AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE',previous.key]]){if(value===undefined)delete process.env[name!];else process.env[name!]=value;}await rm(directory,{recursive:true,force:true});}
});
