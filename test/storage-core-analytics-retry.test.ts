import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {analyticsFailure} from '../src/lib/storage-core/analytics';

test('indexing errors have an explicit retry code while other 503 errors retain their meaning',async()=>{
  const value=analyticsFailure({status:503,code:'ANALYTICS_INDEXING'});
  assert.equal(value.status,503);assert.equal(value.headers.get('retry-after'),'1');
  assert.equal((await value.json()).code,'ANALYTICS_INDEXING');
  assert.equal(analyticsFailure({status:503}).headers.get('x-storage-retry'),null);
});

for(const scenario of ['ready','logout','abort','bound','other-503'])test('original apiFetch handles analytics readiness: '+scenario,async()=>{
  let key:string|null='old-key';let requests=0;let waits=0;const controller=new AbortController();
  const sandboxModule={exports:{}};
  const source=ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{module:sandboxModule,exports:sandboxModule.exports,Headers,Date,process:{env:{}},window:{},localStorage:{getItem:()=>key},setTimeout:(callback:()=>void)=>{waits++;if(scenario==='logout')key=null;if(scenario==='abort')controller.abort();callback();},fetch:async(_url:string,options:RequestInit)=>{
    requests++;assert.equal(new Headers(options.headers).get('x-witty-api-key'),'old-key');
    if(scenario==='ready'&&requests===2)return Response.json({ready:true});
    return Response.json({error:'indexing'},{status:503,headers:scenario==='other-503'?{}:{'x-storage-retry':'analytics-indexing'}});
  }});
  const response=await (sandboxModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch('/api/quality/report',{signal:controller.signal});
  assert.equal(requests,scenario==='ready'?2:scenario==='bound'?16:1);
  assert.equal(waits,scenario==='other-503'?0:scenario==='bound'?15:1);
  assert.equal(response.status,scenario==='ready'?200:503);
});


test('Skill and Agent read consumers transport the current key without changing mutation requests',async()=>{
  const calls:{url:string;key:string|null}[]=[];
  const sandboxModule={exports:{}};
  const source=ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(source,{module:sandboxModule,exports:sandboxModule.exports,Headers,Date,process:{env:{NEXT_PUBLIC_URL_PREFIX:'/insight'}},window:{},localStorage:{getItem:()=> 'current-key'},fetch:async(url:string,options:RequestInit)=>{calls.push({url,key:new Headers(options.headers).get('x-witty-api-key')});return Response.json({});}});
  const api=(sandboxModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch;
  for(const url of ['/api/skills?user=other','/api/skills/skill-id/versions','/api/skills/skill-id/runs?version=1','/api/skills/logs?skill=s','/api/agents?user=other'])await api(url);
  assert.ok(calls.every(call=>call.key==='current-key'));
  assert.ok(calls.every(call=>call.url.startsWith('/insight/api/')));
  await api('/api/skills',{method:'DELETE'});
  assert.equal(calls.at(-1)?.key,null);
  await api('/api/skills',{headers:{'x-witty-api-key':'explicit-key'}});
  assert.equal(calls.at(-1)?.key,'explicit-key');
});
