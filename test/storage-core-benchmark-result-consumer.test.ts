import assert from 'node:assert/strict';
import test from 'node:test';
import {runWithCoreExperimentContext,type CoreExperimentContext} from '@/lib/storage-core/experiments';
import {getBenchmarkExperimentResult,readBenchmarkRunArtifact} from '@/lib/benchmark/experiment-result-service';
import {benchmarkReadSource} from '@/lib/benchmark/core-store';

function fixture(){
 const calls:Record<string,unknown>[]=[];const experiment={id:'exp',name:'Benchmark',user:'alice',scope:'benchmark',status:'done',deletedAt:null,createdAt:'2026-11-14T00:00:00Z',groups:[],comments:[],cases:[{id:'case',experimentId:'exp',deletedAt:null,results:[{id:'slot',evaluatorId:'benchmark:swe-bench',status:'done',verdict:'pass',score:100,summary:'passed',errorMessage:null}],traceAttempts:[]}],benchmarkBinding:{adapterKey:'swe-bench',expectedCaseCount:1}};
 const run={id:'erun',experimentId:'exp',retryOfRunId:null,ordinal:0,status:'evaluated',runFactsJson:'{"traceId":"trace"}',submissionSource:'execution',failureCode:null,failureMessage:null,createdAt:'2026-11-14T00:00:00Z',datasetCase:{externalCaseId:'instance'},artifacts:[],experimentCase:experiment.cases[0],evaluations:[{id:'veval',status:'completed',normalizedResultJson:JSON.stringify({primaryMetric:{key:'resolved',value:true,aggregation:'boolean-rate'},nativeMetrics:{resolved:true}}),runtimeFactsJson:'{}',artifacts:[]}]};
 const fetcher:typeof fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));calls.push(body);return Response.json({value:body.action==='artifact_lookup'?{name:'answer.txt',mediaType:'text/plain',sha256:'sha256:'+'a'.repeat(64),sizeBytes:2,bytes_base64:Buffer.from('ok').toString('base64')}:{coverage:'complete',snapshots:[{coverage:'complete',experiment,benchmark_runs:[run]}]}});};
 const request=new Request('http://localhost/api/benchmark/v1/experiments/exp');const context:CoreExperimentContext={actor:{token:'api',workspace:'workspace',principal:'p',username:'alice'},request,options:{fetcher},operationKey:'op',body:{},rpc:async()=>{throw Error('ordinary Experiment RPC must not substitute Benchmark domain');}};
 return {calls,context};
}
async function core<T>(fn:()=>Promise<T>){const old=process.env.AGENT_INSIGHT_TRACE_STORAGE;const url=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';try{return await fn();}finally{if(old===undefined)delete process.env.AGENT_INSIGHT_TRACE_STORAGE;else process.env.AGENT_INSIGHT_TRACE_STORAGE=old;if(url===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=url;}}

test('original Benchmark aggregation consumes a complete typed core snapshot without legacy tables',async()=>core(async()=>{
 const f=fixture();const result=await runWithCoreExperimentContext(f.context,()=>getBenchmarkExperimentResult({experimentId:'exp',user:'alice',page:1,pageSize:20}));
 assert.equal(result.status,'completed');assert.deepEqual(result.progress,{total:1,completed:1,pending:0,coverageRate:100});assert.equal(result.metrics.averageScore.value,100);assert.equal(result.metrics.primary?.value,100);assert.equal(result.cases[0].execution.traceId,'trace');assert.equal(f.calls[0].action,'read_view');
}));
test('artifact consumer uses the scoped content endpoint and rejects mismatched actor',async()=>core(async()=>{
 const f=fixture();await runWithCoreExperimentContext(f.context,async()=>{const artifact=await readBenchmarkRunArtifact({artifactId:'artifact',user:'alice'});assert.equal(artifact.bytes.toString(),'ok');await assert.rejects(readBenchmarkRunArtifact({artifactId:'artifact',user:'bob'}),{status:403});});assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'artifact_lookup');
}));
test('Benchmark core never falls back to the legacy read client without complete coverage',async()=>core(async()=>{assert.throws(()=>benchmarkReadSource({}),{status:503});}));
