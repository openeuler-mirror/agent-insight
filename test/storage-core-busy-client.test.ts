import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const busy=()=>Response.json({code:'CORE_BUSY'},{status:503,headers:{'x-storage-retry':'core-busy','retry-after':'1'}});
function fixture(respond:(attempt:number,options:RequestInit)=>Response|Promise<Response>){
 let key='alice-key',user='alice';const calls:RequestInit[]=[],waits:number[]=[];
 const module={exports:{}};
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/client/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  module,exports:module.exports,Headers,Response,Date,AbortController,Error,process:{env:{}},window:{},
  localStorage:{getItem:(name:string)=>name==='api_key'?key:name==='user_id'?user:null},
  setTimeout:(fn:()=>void,ms:number)=>{if(ms<14_000)waits.push(ms);return setTimeout(fn,ms<14_000?1:ms);},clearTimeout,
  fetch:async(_url:string,options:RequestInit)=>{calls.push(options);return respond(calls.length,options);},
 });
 return {api:(module.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch,calls,waits,identity:()=>{key='bob-key';user='bob';}};
}
test('Core busy GET retries at most three times with bounded exponential jitter',async()=>{
 const f=fixture(()=>busy());const response=await f.api('/api/observe/data');
 assert.equal(response.status,503);assert.equal(f.calls.length,4);assert.equal(f.waits.length,3);
 for(const [i,ms] of f.waits.entries())assert.ok(ms>=1000*2**i&&ms<1000*2**i+250);
 assert.ok(f.calls.every(call=>new Headers(call.headers).get('x-witty-api-key')==='alice-key'));
});
test('Core busy retries return success and do not replay POST or untyped 503',async()=>{
 const f=fixture(attempt=>attempt===1?busy():Response.json({items:['trace']}));
 assert.deepEqual(await (await f.api('/api/observe/data')).json(),{items:['trace']});assert.equal(f.calls.length,2);
 const post=fixture(()=>busy());assert.equal((await post.api('/api/observe/data',{method:'POST',body:'{}'})).status,503);assert.equal(post.calls.length,1);
 const ordinary=fixture(()=>Response.json({error:'database unavailable'},{status:503}));await ordinary.api('/api/observe/data');assert.equal(ordinary.calls.length,1);
});
test('Core busy retries stop on cancellation or account change',async()=>{
 const controller=new AbortController();const aborted=fixture(()=>{controller.abort();return busy();});
 await assert.rejects(aborted.api('/api/observe/data',{signal:controller.signal}));assert.equal(aborted.calls.length,1);
 const changed=fixture(()=>{changed.identity();return busy();});
 await assert.rejects(changed.api('/api/observe/data'));assert.equal(changed.calls.length,1);
 const changedInFlight=fixture(attempt=>{if(attempt===1)return busy();changedInFlight.identity();return Response.json({private:'alice'});});
 await assert.rejects(changedInFlight.api('/api/observe/data'));assert.equal(changedInFlight.calls.length,2);
});
