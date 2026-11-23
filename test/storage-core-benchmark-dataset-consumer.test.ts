import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {registerBenchmarkAdapter} from '@/lib/benchmark/adapter-registry';
import {importBenchmarkDataset} from '@/lib/benchmark/dataset-service';
import {runWithCoreExperimentContext,type CoreExperimentContext} from '@/lib/storage-core/experiments';

registerBenchmarkAdapter({manifest:{adapterKey:'core-fixture',displayName:'Core Fixture',presentation:{caseTable:{columns:[]}}},validateAndSplitCase:(raw:unknown)=>{const value=raw as {id:string;question:string;answer:string};return {externalCaseId:value.id,publicPayload:{input:value.question},privatePayload:{answer:value.answer},publicFingerprint:'sha256:'+'a'.repeat(64),privateFingerprint:'sha256:'+'b'.repeat(64),catalogProjection:{input:value.question,values:{}}};}} as never);

test('Benchmark Dataset consumer seals public/private splits in one attested core operation with stable retry identities',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'core-benchmark-dataset-'));const key=path.join(directory,'controller');await writeFile(key,'a'.repeat(64),{mode:0o600});
 const previous={mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL,key:process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE};process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=key;
 const calls:Record<string,unknown>[]=[];const request=new Request('http://localhost/api/benchmark/datasets');const context:CoreExperimentContext={actor:{token:'api',workspace:'w',principal:'p',username:'alice'},request,operationKey:'dataset-import',body:{},rpc:async()=>{throw Error('legacy domain');},options:{fetcher:async(_url,init)=>{const body=JSON.parse(String(init?.body));if(body.action==='lookup_operation')return Response.json({value:null});assert.ok(new Headers(init?.headers).get('x-storage-controller-proof'));calls.push(body);return Response.json({value:{id:body.dataset_id,contentHash:body.content_hash,caseCount:body.cases.length}});}}};
 try{await runWithCoreExperimentContext(context,async()=>{
  const input={user:'alice',name:'Fixture',adapterKey:'core-fixture',cases:[{id:'external',question:'PUBLIC QUESTION',answer:'PRIVATE GOLD'}]};const first=await importBenchmarkDataset(input);const second=await importBenchmarkDataset(input);assert.deepEqual(first,second);assert.deepEqual(calls[0],calls[1]);
  const body=calls[0] as {public_dataset:{cases:Array<{id:string}>};cases:Array<{id:string;privatePayload:unknown}>};assert.ok(!JSON.stringify(body.public_dataset).includes('PRIVATE GOLD'));assert.equal(body.public_dataset.cases[0].id,body.cases[0].id);assert.ok(JSON.stringify(body.cases[0].privatePayload).includes('PRIVATE GOLD'));
  await assert.rejects(importBenchmarkDataset({...input,user:'bob'}),{httpStatus:403});assert.equal(calls.length,2);
 });}finally{for(const [env,value] of [['AGENT_INSIGHT_TRACE_STORAGE',previous.mode],['AGENT_INSIGHT_STORAGE_CORE_URL',previous.url],['AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE',previous.key]]){if(value===undefined)delete process.env[env!];else process.env[env!]=value;}await rm(directory,{recursive:true,force:true});}
});
