import assert from 'node:assert/strict';
import test from 'node:test';
import {handleCompatibleObserveData} from '@/lib/storage-core/compat';
import {withCoreReadRetry,coreReadChanged,markCoreReadSideEffect} from '@/lib/storage-core/read-retry';
import {requestCore} from '@/lib/storage-core/server';

const previous=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;
process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19021';
const headers={authorization:'Bearer api_'+'x'.repeat(43)};
const profile=(principal='alice')=>Response.json({principal_id:principal,username:principal,workspace_id:'w',workspaces:[{workspace_id:'w',role:'member'}]});
const request=(options:RequestInit={})=>new Request('http://localhost/api/observe/data?taskId=task',{headers,...options});

test('recognized indexing and source transitions reauthorize and rebuild the original read',async()=>{
 let reads=0,identities=0;
 const response=await handleCompatibleObserveData(request(),{fetcher:async(input)=>{
  if(new URL(String(input)).pathname==='/v1/auth/me'){identities++;return profile();}
  reads++;return reads===1?Response.json({code:'TRACE_INDEXING'},{status:503}):reads===2?Response.json({code:'TRACE_READ_CHANGED'},{status:409}):Response.json({value:[{task_id:'task',label:'updated'}]});
 }});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),[{task_id:'task',label:'updated'}]);assert.equal(reads,3);assert.equal(identities,3);
});

test('ordinary storage errors, bad code/status pairs and authorization failures are never retried',async()=>{
 for(const [status,code] of [[409,undefined],[503,undefined],[401,undefined],[403,undefined],[404,undefined],[413,undefined],[409,'TRACE_INDEXING'],[503,'TRACE_READ_CHANGED']] as const){
  let reads=0;
  const response=await handleCompatibleObserveData(request(),{fetcher:async(input)=>{
   if(new URL(String(input)).pathname==='/v1/auth/me')return profile();reads++;return Response.json({error:'permanent',code},{status});
  }});assert.equal(response.status,status);assert.equal(reads,1);
 }
});

test('retry never adopts a different principal or continues after credential revocation',async()=>{
 for(const revoked of [false,true]){
  let reads=0,identities=0;
  const response=await handleCompatibleObserveData(request(),{fetcher:async(input)=>{
   if(new URL(String(input)).pathname==='/v1/auth/me'){identities++;return identities===1?profile():revoked?Response.json({error:'revoked'},{status:401}):profile('bob');}
   reads++;return Response.json({code:'TRACE_INDEXING'},{status:503});
  }});assert.equal(response.status,revoked?401:403);assert.equal(reads,1);assert.equal(identities,2);
 }
});

test('read cancellation interrupts the delay without another storage request',async()=>{
 const abort=new AbortController();let reads=0;
 const response=await handleCompatibleObserveData(request({signal:abort.signal}),{fetcher:async(input)=>{
  if(new URL(String(input)).pathname==='/v1/auth/me')return profile();reads++;setTimeout(()=>abort.abort(new Error('reader cancelled')),10);return Response.json({code:'TRACE_INDEXING'},{status:503});
 }});assert.notEqual(response.status,200);assert.equal(reads,1);assert.equal(abort.signal.aborted,true);
});

test('write requests are not replayed when storage reports a read-transition code',async()=>{
 let writes=0;
 const response=await handleCompatibleObserveData(request({method:'DELETE',body:'{"task_id":"task"}'}),{fetcher:async(input)=>{
  if(new URL(String(input)).pathname==='/v1/auth/me')return profile();writes++;return Response.json({code:'TRACE_INDEXING'},{status:503});
 }});assert.equal(response.status,503);assert.equal(writes,1);
});

test('a callback that entered a model or write side effect is not replayed',async()=>{
 let executions=0;
 await assert.rejects(withCoreReadRetry(request(),async()=>{markCoreReadSideEffect();executions++;throw coreReadChanged('changed after execution');}),(error:any)=>error.status===409);assert.equal(executions,1);
});

test('nested reads share the outer attempt instead of multiplying retries',async()=>{
 let reads=0;
 const value=await withCoreReadRetry(request(),()=>withCoreReadRetry(request(),async()=>{if(++reads<3)throw coreReadChanged('source changed');return 'current';}));assert.equal(value,'current');assert.equal(reads,3);
});

test('a core origin change cannot send the original credential to a second origin',async()=>{
 const urls:string[]=[];
 try{await assert.rejects(withCoreReadRetry(request(),async()=>{
  const fetcher:typeof fetch=async input=>{urls.push(String(input));process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19022';return profile();};
  await requestCore('/v1/auth/me',{token:'private-credential'},fetcher);await requestCore('/v1/compat/observe/data',{token:'private-credential'},fetcher);
 }),(error:any)=>error.status===503);assert.deepEqual(urls,['http://127.0.0.1:19021/v1/auth/me']);}
 finally{process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19021';}
});

test('cancellation inside a storage response stops subsequent auth and analytics RPCs',async()=>{
 const abort=new AbortController(),reason=new Error('cancelled in response');let requests=0;
 await assert.rejects(withCoreReadRetry(request({signal:abort.signal}),async()=>{
  const fetcher:typeof fetch=async()=>{requests++;abort.abort(reason);return Response.json({value:[]});};
  await requestCore('/v1/compat/analytics',{method:'POST',body:'{"action":"ras_read"}'},fetcher);await requestCore('/v1/auth/me',{},fetcher);
 }),error=>error===reason);assert.equal(requests,1);
});

test('the waiting deadline cannot start another storage attempt after its last delay',async context=>{
 context.mock.timers.enable({apis:['Date','setTimeout'],now:0});let reads=0;
 const pending=withCoreReadRetry(request(),async()=>{if(++reads>1)return 'unexpected';context.mock.timers.tick(14999);throw Object.assign(new Error('indexing'),{status:503,code:'TRACE_INDEXING'});});
 const rejected=assert.rejects(pending,(error:any)=>error.code==='TRACE_INDEXING');await Promise.resolve();await Promise.resolve();context.mock.timers.tick(1);await rejected;assert.equal(reads,1);
});

test('related Session-source reads retain the narrow transition code through the transport',async()=>{
 let reads=0;const value=await withCoreReadRetry(request(),()=>requestCore('/v1/compat/observe/session-sources?workspace_id=w',{},async()=>++reads===1?Response.json({code:'TRACE_INDEXING'},{status:503}):Response.json({value:[]})));assert.deepEqual(value.data.value,[]);assert.equal(reads,2);
});

test('persistent indexing remains an error after bounded retries',async()=>{
 let reads=0;
 await assert.rejects(withCoreReadRetry(request(),async()=>{reads++;throw Object.assign(new Error('still indexing'),{status:503,code:'TRACE_INDEXING'});}),(error:any)=>error.status===503&&error.code==='TRACE_INDEXING');assert.ok(reads>1&&reads<=32);
});
test.after(()=>{if(previous===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous;});
