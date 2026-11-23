import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runWithCoreExperimentContext,type CoreExperimentContext} from '@/lib/storage-core/experiments';
import * as retry from '@/lib/benchmark/core-retry';

async function fixture<T>(run:(context:CoreExperimentContext,calls:Record<string,unknown>[])=>Promise<T>,options:{replay?:boolean;conflict?:boolean}={}){
 const directory=await mkdtemp(path.join(os.tmpdir(),'benchmark-case-retry-'));const key=path.join(directory,'controller');await writeFile(key,'a'.repeat(64),{mode:0o600});const old={url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL,key:process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE};process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=key;const calls:Record<string,unknown>[]=[];
 const result={status:'running',alreadyRunning:false,runId:'erun_new',runplanId:'new-frozen-plan'};
 const context:CoreExperimentContext={actor:{principal:'p',workspace:'w',username:'alice',token:'api'},request:new Request('http://localhost/retry'),operationKey:'retry-op',body:{},rpc:async()=>{throw Error('generic mutation forbidden');},options:{fetcher:async(_url,init)=>{const body=JSON.parse(String(init?.body));calls.push(body);if(body.action==='lookup_operation')return Response.json({value:options.replay?result:null});assert.ok(new Headers(init?.headers).get('x-storage-controller-proof')||body.action==='claim');if(body.action==='prepare_case_retry'){if(options.conflict)return Response.json({error:{message:'cleanup unconfirmed'}},{status:409});return Response.json({value:{previous_job_id:'erun_old',expected_machine_result_id:'old-machine'}});}if(body.action==='retry_case'){assert.equal(body.previous_job_id,'erun_old');assert.equal(body.expected_machine_result_id,'old-machine');assert.equal(body.config,undefined);assert.equal(body.releases,undefined);return Response.json({value:result});}assert.equal(body.action,'claim');assert.equal(body.job_id,'erun_new');return Response.json({value:null});}}};
 try{return await run(context,calls);}finally{if(old.url===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=old.url;if(old.key===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=old.key;await rm(directory,{recursive:true,force:true});}
}

test('Case retry CAS creates a frozen run and leaves budget-blocked dispatch durable',async()=>fixture(async(context,calls)=>{
 assert.equal(typeof retry.retryCoreBenchmarkCase,'function');const result=await runWithCoreExperimentContext(context,()=>retry.retryCoreBenchmarkCase({experimentId:'exp',caseId:'case',user:'alice'}));await result.completion;assert.equal(result.runId,'erun_new');assert.equal(result.runplanId,'new-frozen-plan');assert.deepEqual(calls.map(row=>row.action),['lookup_operation','prepare_case_retry','retry_case','claim']);assert.deepEqual(calls[2].operation_request,{experiment_id:'exp',case_id:'case'});
}));
test('Case retry replay dispatches the original new job without creating another attempt',async()=>fixture(async(context,calls)=>{
 const result=await runWithCoreExperimentContext(context,()=>retry.retryCoreBenchmarkCase({experimentId:'exp',caseId:'case',user:'alice'}));await result.completion;assert.deepEqual(calls.map(row=>row.action),['lookup_operation','claim']);
},{replay:true}));
test('Case retry refuses unconfirmed cleanup and actor mismatch before mutation',async()=>fixture(async(context,calls)=>{
 await assert.rejects(runWithCoreExperimentContext(context,()=>retry.retryCoreBenchmarkCase({experimentId:'exp',caseId:'case',user:'bob'})),{status:403});assert.equal(calls.length,0);await assert.rejects(runWithCoreExperimentContext(context,()=>retry.retryCoreBenchmarkCase({experimentId:'exp',caseId:'case',user:'alice'})),{status:409});assert.deepEqual(calls.map(row=>row.action),['lookup_operation','prepare_case_retry']);
},{conflict:true}));
