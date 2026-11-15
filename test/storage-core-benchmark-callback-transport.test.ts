import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
interface CallbackRequest {runId:string;platformBaseUrl:string;callbackBaseUrl:string;callbackHeaders?:Record<string,string>}
interface Client {progress(request:CallbackRequest,event:unknown):Promise<unknown>;downloadArtifact(request:CallbackRequest,descriptor:unknown):Promise<unknown>;complete(request:CallbackRequest,event:unknown):Promise<unknown>}
const {AgentInsightPlatformClient}=require('../services/evaluator/src/platform-client.cjs') as {AgentInsightPlatformClient:new (fetcher:typeof fetch)=>Client};
const capability='bcap_'+Buffer.from('scoped fixture').toString('base64url')+'.'+'a'.repeat(64);
const request:CallbackRequest={runId:'job',platformBaseUrl:'https://platform.test',callbackBaseUrl:'https://platform.test/api/benchmark/v1/evaluations/job',callbackHeaders:{'x-agent-insight-callback-token':capability}};

test('the actual evaluator HTTP client forwards the scoped capability on progress and completion',async()=>{
 const headers:Headers[]=[];const client=new AgentInsightPlatformClient(async(_url,options)=>{headers.push(new Headers(options?.headers));return Response.json(String(_url).endsWith('/progress')?{accepted:true,desiredState:'continue'}:{accepted:true,evaluationStatus:'completed',normalizationStatus:'completed',normalizedResult:{status:'done'}});});
 await client.progress(request,{stage:'running_harness'});await client.complete(request,{status:'completed'});
 assert.deepEqual(headers.map(value=>value.get('x-agent-insight-callback-token')),[capability,capability]);
});

test('arbitrary callback headers are rejected before transport and legacy requests stay unchanged',async()=>{
 let calls=0;const headers:Headers[]=[];const client=new AgentInsightPlatformClient(async(_url,options)=>{calls++;headers.push(new Headers(options?.headers));return Response.json({accepted:true,desiredState:'continue'});});
 await assert.rejects(client.progress({...request,callbackHeaders:{authorization:'untrusted'}},{}),/callback|capability|headers/i);assert.equal(calls,0);
 const legacy={...request};delete legacy.callbackHeaders;await client.progress(legacy,{});assert.equal(headers[0].has('x-agent-insight-callback-token'),false);
});

test('the actual executor forwards both the authenticated device and narrowly scoped capability',async()=>{
 const {AgentInsightCallbackClient,dispatchDigest}=require('../services/executor/src/index.cjs') as {AgentInsightCallbackClient:new(options:Record<string,unknown>)=>{progress(request:unknown,stage:string):Promise<unknown>;uploadArtifact(request:unknown,artifact:unknown):Promise<unknown>;complete(request:unknown,completion:unknown):Promise<unknown>};dispatchDigest:(request:unknown)=>string};
 const headers:Headers[]=[];const client=new AgentInsightCallbackClient({clientId:'actual-device',deviceCredential:'device-secret',insightBaseUrl:'https://platform.test',fetchImpl:async(_url:unknown,options:RequestInit)=>{headers.push(new Headers(options.headers));return Response.json({accepted:true});}});
 const value={...request,task:{task:'fixture'},timeoutSeconds:30};const legacy={...value};delete legacy.callbackHeaders;assert.equal(dispatchDigest(value),dispatchDigest(legacy));
 await client.progress(value,'agent_running');await client.uploadArtifact(value,{name:'answer.txt',mediaType:'text/plain',sha256:'sha256:'+'a'.repeat(64),bytes:Buffer.from('answer')});await client.complete(value,{kind:'execution',status:'succeeded'});
 assert.deepEqual(headers.map(value=>[value.get('authorization'),value.get('x-agent-insight-client-id'),value.get('x-agent-insight-callback-token')]),Array(3).fill(['Bearer device-secret','actual-device',capability]));
});

test('callback bridge signs the actual device into the exact body without forwarding an API credential',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const os=await import('node:os');const path=await import('node:path');const {benchmarkCallbackRpc}=await import('@/lib/benchmark/core-store');const {signControllerPayload}=await import('@/lib/storage-core/controller');
 const directory=await mkdtemp(path.join(os.tmpdir(),'benchmark-device-proof-'));const key=path.join(directory,'controller');await writeFile(key,'a'.repeat(64),{mode:0o600});const previous={key:process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL};process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=key;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
 const value='bcap_'+Buffer.from(JSON.stringify({principal_id:'principal',workspace_id:'workspace'})).toString('base64url')+'.'+'a'.repeat(64);
 try{await benchmarkCallbackRpc({capability:value,verifiedDeviceClientId:'actual-device',fetcher:async(_url,options)=>{const body=String(options?.body);const headers=new Headers(options?.headers);assert.equal(JSON.parse(body).verified_device_client_id,'actual-device');assert.equal(headers.get('x-benchmark-device-client'),'actual-device');assert.equal(headers.get('x-storage-benchmark-device-proof'),signControllerPayload('a'.repeat(64),'benchmark-device/v1','principal','workspace',body));assert.equal(headers.get('authorization'),null);assert.equal(body.includes(value),false);return Response.json({value:{accepted:true}});}},'progress',{job_id:'job',verified_device_client_id:'forged-device'});}finally{if(previous.key===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=previous.key;if(previous.url===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous.url;await rm(directory,{recursive:true,force:true});}
});

test('TypeScript and actual service digests use the same fixed business fields across private dispatch envelopes',async()=>{
 const {benchmarkDispatchDigest}=await import('../packages/benchmark-protocol/src/contracts');const {benchmarkEvaluationDispatchDigest}=await import('../packages/benchmark-protocol/src/evaluation-contracts');const {dispatchDigest}=require('../services/executor/src/index.cjs');const {evaluationDispatchDigest}=require('../services/evaluator/src/service.cjs');
 const execution={runId:'fixed',task:{input:'public'},callbackBaseUrl:'https://platform.test/callback',timeoutSeconds:30,callbackHeaders:{'x-agent-insight-callback-token':capability},clientId:'private-target',requestDigest:'sha256:'+'c'.repeat(64)};
 assert.equal(benchmarkDispatchDigest(execution as never),dispatchDigest(execution));
 const evaluation={runId:'fixed',evaluationJob:{payload:{privateInput:'fixture'}},platformBaseUrl:'https://platform.test',callbackBaseUrl:'https://platform.test/callback',timeoutSeconds:30,callbackHeaders:{'x-agent-insight-callback-token':capability},dispatchTarget:{baseUrl:'https://evaluator.test'},requestDigest:'sha256:'+'c'.repeat(64)};
 assert.equal(benchmarkEvaluationDispatchDigest(evaluation as never),evaluationDispatchDigest(evaluation));
});
