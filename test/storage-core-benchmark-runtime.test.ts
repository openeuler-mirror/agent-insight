import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {createHash} from 'node:crypto';
import {registerBenchmarkAdapter} from '@/lib/benchmark/adapter-registry';
import {defaultEvaluatorTargetResolver} from '@/lib/benchmark/evaluator-target';
import {completeCoreBenchmarkExecution,completeCoreBenchmarkEvaluation} from '@/lib/benchmark/core-runtime';
import type {BenchmarkEvaluationCompletion} from '../packages/benchmark-protocol/src/evaluator-contracts';
import type {JsonValue} from '../packages/benchmark-protocol/src/contracts';

const manifest={adapterKey:'core-runtime-fixture',displayName:'Runtime Fixture',evaluation:{evaluatorKey:'core-runtime-fixture',defaultTimeoutSeconds:30,defaultResources:{cpu:1,memoryMiB:128}},requiredArtifacts:[{name:'answer.txt',mediaType:'text/plain',maxBytes:128}]};
registerBenchmarkAdapter({manifest,validateSubmission:async(input:{artifacts:Array<{readBytes:()=>Promise<Uint8Array>}>})=>{assert.equal(Buffer.from(await input.artifacts[0].readBytes()).toString(),'answer');},buildEvaluationRequest:(input:{context:{evaluationRunId:string;executionRunId:string;experimentId:string;caseId:string;datasetContentHash:string};artifacts:unknown[];privatePayload:JsonValue})=>({protocolVersion:'benchmark-evaluation/v1',evaluationId:input.context.evaluationRunId,executionRunId:input.context.executionRunId,context:{experimentId:input.context.experimentId,caseId:input.context.caseId,datasetContentHash:input.context.datasetContentHash},benchmark:{key:manifest.adapterKey},evaluator:{key:manifest.evaluation.evaluatorKey},artifacts:input.artifacts,payload:input.privatePayload,limits:{timeoutSeconds:30,cpu:1,memoryMiB:128}}),normalizeResult:(input:{evidenceArtifacts:Array<{jsonContent?:JsonValue}>})=>{assert.deepEqual(input.evidenceArtifacts[0].jsonContent,{actualScore:70});return {status:'done',score:70,verdict:'pass',summary:'actual adapter',points:[],evidence:{artifactIds:['report']},nativeMetrics:{passed:true}};}} as never);

const cap='bcap_'+Buffer.from(JSON.stringify({principal_id:'p',workspace_id:'w'})).toString('base64url')+'.'+'a'.repeat(64);
async function controller<T>(action:()=>Promise<T>){const directory=await mkdtemp(path.join(os.tmpdir(),'benchmark-core-runtime-'));const key=path.join(directory,'controller');await writeFile(key,'a'.repeat(64),{mode:0o600});const old={key:process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=key;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';try{return await action();}finally{if(old.key===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=old.key;if(old.url===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=old.url;await rm(directory,{recursive:true,force:true});}}
const artifact=(id:string,name:string,mediaType:string,bytes:Buffer)=>({artifactId:id,name,kind:'evidence',media_type:mediaType,size:bytes.length,sha256:'sha256:'+createHash('sha256').update(bytes).digest('hex'),bytes_base64:bytes.toString('base64')});
function base(){return {handle:{job_id:'erun',experiment_id:'exp',case_id:'case'},job:{job_id:'erun',adapter_key:manifest.adapterKey,evaluator_key:manifest.evaluation.evaluatorKey},binding:{dataset_content_hash:'sha256:'+'b'.repeat(64),adapter:{...manifest,key:manifest.adapterKey,evaluatorId:'benchmark:'+manifest.evaluation.evaluatorKey},run_config:{}},case:{dataset_case:{publicPayload:{question:'public'},privatePayload:{answer:'PRIVATE GOLD'},rawCase:{}}},runplan:{config:{public_callback_origin:'https://platform.test',executor_callback_origin:'https://platform.test'}},request:{task:{agentConfig:{platform:'fixture',agent:'agent'}}}};}

test('execution completion validates actual submission before sealing and dispatching a stable child job',async(t)=>controller(async()=>{
 t.mock.method(defaultEvaluatorTargetResolver,'resolve',()=>({baseUrl:'https://evaluator.test',evaluatorKey:manifest.evaluation.evaluatorKey,targetKey:'frozen-target'}));let sealed:Record<string,unknown>|undefined;const calls:string[]=[];
 const fetcher:typeof fetch=async(url,options)=>{const body=JSON.parse(String(options?.body));if(String(url).startsWith('https://evaluator.test')){calls.push('HTTP dispatch');assert.equal(body.dispatchTarget,undefined);assert.deepEqual(body.callbackHeaders,{'x-agent-insight-callback-token':cap});return Response.json({runId:body.runId,requestDigest:body.requestDigest,status:'accepted'},{status:202});}
  calls.push(body.action);if(body.action==='claim_next_execution')return Response.json({value:null});assert.equal(new Headers(options?.headers).get('authorization'),null);
  if(body.action==='execution_complete')return Response.json({value:{accepted:true,status:'submitted'}});
  if(body.action==='load_next_work')return Response.json({value:{...base(),artifacts:[artifact('answer','answer.txt','text/plain',Buffer.from('answer'))]}});
  if(body.action==='evaluation_prepare'){sealed=body.request;assert.deepEqual((sealed!.evaluationJob as {payload:unknown}).payload,{answer:'PRIVATE GOLD'});return Response.json({value:{evaluationRunId:sealed!.runId}});}
  if(body.action==='load_child_dispatch')return Response.json({value:{handle:{attempt_id:'attempt',fence:'1',lease_owner:'worker'},request:{...sealed,callbackHeaders:{'x-agent-insight-callback-token':cap}}}});
  assert.equal(body.action,'child_dispatch_checkpoint');assert.equal(body.state,'accepted');return Response.json({value:{protocol_state:'running_evaluator'}});
 };
 assert.deepEqual(await completeCoreBenchmarkExecution({capability:cap,verifiedDeviceClientId:'actual-device',fetcher},'erun',{status:'succeeded'}),{accepted:true,status:'submitted'});
 assert.deepEqual(calls,['execution_complete','load_next_work','evaluation_prepare','load_child_dispatch','HTTP dispatch','child_dispatch_checkpoint','claim_next_execution']);
}));

test('raw completion is persisted before actual evidence decoding and adapter normalization selects its result',async()=>controller(async()=>{
 const completion={status:'completed',rawResult:{claimedScore:100},evidenceArtifactIds:['report'],runtimeFacts:{},cleanup:{controller:{status:'succeeded'}}} as unknown as BenchmarkEvaluationCompletion;const calls:string[]=[];
 const fetcher:typeof fetch=async(_url,options)=>{const body=JSON.parse(String(options?.body));calls.push(body.action);if(body.action==='claim_next_execution')return Response.json({value:null});
  if(body.action==='evaluation_complete')return Response.json({value:{completion_hash:'raw-hash'}});
  if(body.action==='load_normalization_work')return Response.json({value:{...base(),job:{...base().job,job_id:'veval'},request:{evaluationJob:{payload:{answer:'PRIVATE GOLD'}}},completion,completion_hash:'raw-hash',artifacts:[artifact('report','report.json','application/json',Buffer.from('{"actualScore":70}'))]}});
  assert.equal(body.action,'normalize_commit');assert.equal(body.raw_completion_hash,'raw-hash');assert.equal(body.normalized.score,70);assert.equal(JSON.stringify(body.normalized).includes('PRIVATE GOLD'),false);return Response.json({value:{accepted:true,normalizedResult:body.normalized}});
 };
 const result=await completeCoreBenchmarkEvaluation({capability:cap,fetcher},'veval',completion) as {normalizedResult:{score:number}};assert.equal(result.normalizedResult.score,70);assert.deepEqual(calls,['evaluation_complete','load_normalization_work','normalize_commit','claim_next_execution']);
}));

test('definite evaluator protocol rejection is distinct from unknown transport and bounded response',async()=>controller(async()=>{
 const {dispatchCoreBenchmarkChild}=await import('@/lib/benchmark/core-runtime');
 for(const [http,reply,expected] of [[422,{error:{code:'REQUEST_INVALID',retryable:false}},'failed'],[409,{error:{code:'ALREADY_EXISTS',retryable:false}},'unknown'],[503,{error:{code:'BUSY',retryable:true}},'unknown'],[422,'x'.repeat(65537),'unknown']] as const){
  let actual:unknown;const fetcher:typeof fetch=async(url,options)=>{if(String(url).startsWith('https://evaluator.test'))return typeof reply==='string'?new Response(reply,{status:http}):Response.json(reply,{status:http});const body=JSON.parse(String(options?.body));if(body.action==='load_child_dispatch')return Response.json({value:{handle:{attempt_id:'attempt'},request:{runId:'eval',requestDigest:'sha256:'+'a'.repeat(64),dispatchTarget:{baseUrl:'https://evaluator.test',evaluatorKey:'fixture'}}}});assert.equal(body.action,'child_dispatch_checkpoint');actual=body.state;return Response.json({value:{}});};
  await dispatchCoreBenchmarkChild({capability:cap,fetcher},'parent','eval');assert.equal(actual,expected);
 }
}));

test('callback refill refuses missing legacy alias and real device owner mismatch before dispatch',async()=>controller(async()=>{
 const {refillCoreBenchmarkExecutions}=await import('@/lib/benchmark/core-runtime');
 for(const [owner,device,status] of [[undefined,undefined,503],['legacy-owner','other-owner',403]] as const){
  const fetcher:typeof fetch=async(_url,options)=>{const body=JSON.parse(String(options?.body));assert.equal(body.action,'claim_next_execution');return Response.json({value:{...base(),actor_username:'iam-login',binding:{...base().binding,run_config:{legacyOwner:owner}}}});};
  await assert.rejects(()=>refillCoreBenchmarkExecutions({capability:cap,verifiedDeviceOwner:device,fetcher},'parent'),error=>Boolean(error&&typeof error==='object'&&'status'in error&&error.status===status));
 }
}));
