import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
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

test('Batch transports the actor key and retains one operation key until its full successful response arrives',async()=>{
 const memory=new Map<string,string>();const seen:Array<{actor:string|null;operation:string|null}>=[];let sequence=0;let loseResponse=true;
 const sandboxModule={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module:sandboxModule,exports:sandboxModule.exports,Headers,Date,process:{env:{}},window:{},localStorage:{getItem:()=> 'current-key'},TextEncoder,Uint8Array,crypto:{subtle:webcrypto.subtle,randomUUID:()=> 'operation-'+(++sequence)},sessionStorage:{getItem:(key:string)=>memory.get(key)||null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)},fetch:async(_url:string,options:RequestInit)=>{
  const headers=new Headers(options.headers);seen.push({actor:headers.get('x-witty-api-key'),operation:headers.get('idempotency-key')});
  if(loseResponse){loseResponse=false;throw Error('response lost');}return Response.json({ok:true});
 }});
 const api=(sandboxModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch;
 const options={method:'POST',body:JSON.stringify({action:'evaluate',caseIds:['one'],user:'forged'})};
 await assert.rejects(()=>api('/api/debug/batch-tasks/batch',options),/response lost/);
 await api('/api/debug/batch-tasks/batch',options);await api('/api/debug/batch-tasks/batch',options);
 assert.ok(seen.every(call=>call.actor==='current-key'));assert.ok(seen[0].operation);
 assert.equal(seen[0].operation,seen[1].operation);assert.notEqual(seen[1].operation,seen[2].operation);
 assert.equal(memory.size,0);
});

for(const scenario of ['body-loss','storage-failure','explicit-key','account-switch','selection-change','task-change','bounded'])test('Batch logical receipt boundary: '+scenario,async()=>{
 const memory=new Map<string,string>();const seen:string[]=[];let actor='actor-a';let sequence=0;let fail=true;
 const sandboxModule={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module:sandboxModule,exports:sandboxModule.exports,Headers,Date,TextEncoder,Uint8Array,process:{env:{}},window:{},localStorage:{getItem:()=>actor},crypto:{subtle:webcrypto.subtle,randomUUID:()=> 'operation-'+(++sequence)},sessionStorage:{getItem:(key:string)=>{if(scenario==='storage-failure')throw Error('storage denied');return memory.get(key)||null;},setItem:(key:string,value:string)=>{if(scenario==='storage-failure')throw Error('storage denied');memory.set(key,value);},removeItem:(key:string)=>memory.delete(key)},fetch:async(_url:string,options:RequestInit)=>{
  seen.push(new Headers(options.headers).get('idempotency-key')||'');
  if(scenario==='bounded')throw Error('response lost');
  if(fail&&scenario==='body-loss'){fail=false;return new Response(new ReadableStream({start(controller){controller.error(Error('body lost'));}}));}
  if(fail&&['account-switch','selection-change','task-change'].includes(scenario)){fail=false;throw Error('response lost');}
  return Response.json({ok:true});
 }});
 const api=(sandboxModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch;
 const options:RequestInit={method:'POST',body:JSON.stringify({action:'retry-evaluate',caseIds:['one'],user:'forged'})};
 if(scenario==='explicit-key')options.headers={'idempotency-key':'given'};
 if(scenario==='bounded'){
  for(let index=0;index<40;index++)await assert.rejects(()=>api('/api/debug/batch-tasks/batch',{...options,body:JSON.stringify({action:'evaluate',caseIds:[String(index)]})}),/response lost/);
  const stored=JSON.parse([...memory.values()][0]) as Array<Record<string,unknown>>;assert.ok(stored.length<=32);assert.ok(stored.every(value=>Object.keys(value).sort().join(',')==='createdAt,key,scope,signature'&&typeof value.scope==='string'&&/^[a-f0-9]{64}$/.test(value.scope)));assert.ok(![...memory.values()].join('').includes('actor-a'));return;
 }
 const first=()=>api('/api/debug/batch-tasks/batch',options);
 if(['body-loss','account-switch','selection-change','task-change'].includes(scenario))await assert.rejects(first,/lost/);else await first();
 if(scenario==='account-switch')actor='actor-b';
 if(scenario==='selection-change')options.body=JSON.stringify({action:'retry-evaluate',caseIds:['two'],user:'forged'});
 await api(scenario==='task-change'?'/api/debug/batch-tasks/other':'/api/debug/batch-tasks/batch',options);
 if(scenario==='body-loss')assert.equal(seen[0],seen[1]);
 else if(scenario==='explicit-key'){assert.deepEqual(seen,['given','given']);assert.equal(memory.size,0);}
 else assert.notEqual(seen[0],seen[1]);
});

for(const action of ['evaluate','retry-evaluate','start','retry-execute'])for(const firstBody of ['{"ok":','{"ok":false}','{"success":true}'])test('Batch keeps an unconfirmed operation key for '+action+' response '+firstBody,async()=>{
 const memory=new Map<string,string>();const seen:string[]=[];let sequence=0;let responses=0;
 const sandboxModule={exports:{}};
 const source=ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module:sandboxModule,exports:sandboxModule.exports,Headers,Date,TextEncoder,Uint8Array,process:{env:{}},window:{},localStorage:{getItem:()=> 'actor'},crypto:{subtle:webcrypto.subtle,randomUUID:()=> 'operation-'+(++sequence)},sessionStorage:{getItem:(key:string)=>memory.get(key)||null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)},fetch:async(_url:string,options:RequestInit)=>{
  seen.push(new Headers(options.headers).get('idempotency-key')||'');
  return responses++===0?new Response(firstBody,{status:200,headers:{'content-type':'application/json'}}):Response.json({ok:true});
 }});
 const api=(sandboxModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch;
 const options={method:'POST',body:JSON.stringify({action,caseIds:['one']})};
 const first=async()=>{const response=await api('/api/debug/batch-tasks/batch',options);return response.json();};
 if(firstBody==='{"ok":')await assert.rejects(first,SyntaxError);else await first();
 const retry=await api('/api/debug/batch-tasks/batch',options);assert.equal((await retry.json()).ok,true);
 assert.ok(seen[0]);assert.equal(seen[0],seen[1]);assert.equal(memory.size,0);
 await api('/api/debug/batch-tasks/batch',options);assert.notEqual(seen[1],seen[2]);
});

for(const scenario of ['ordinary-json','ordinary-text','explicit-key'])test('Batch acknowledgement validation preserves '+scenario+' response handling',async()=>{
 const sandboxModule={exports:{}};const seen:Array<string|null>=[];
 const source=ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module:sandboxModule,exports:sandboxModule.exports,Headers,Date,process:{env:{}},window:{},localStorage:{getItem:()=> 'actor'},fetch:async(_url:string,options:RequestInit)=>{seen.push(new Headers(options.headers).get('idempotency-key'));return new Response(scenario==='ordinary-text'?'plain text':'{"ok":',{status:200});}});
 const api=(sandboxModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch;
 const explicit=scenario==='explicit-key';
 const response=await api(explicit?'/api/debug/batch-tasks/batch':'/api/quality/report',{method:'POST',body:JSON.stringify({action:'evaluate',caseIds:['one']}),...(explicit?{headers:{'idempotency-key':'caller-supplied'}}:{})});
 assert.equal(response.status,200);assert.equal(seen[0],explicit?'caller-supplied':null);
 if(scenario==='ordinary-text')assert.equal(await response.text(),'plain text');else await assert.rejects(()=>response.json(),SyntaxError);
});

for(const acknowledgement of ['{"ok":true}','{"ok":false}','{"ok":'])test('Batch abort only retires matching authenticated Task intents after '+acknowledgement,async()=>{
 const memory=new Map<string,string>(),seen:Array<{url:string;actor:string;key:string;action:string}>=[];let actor='alice',release=false,sequence=0;
 const sandboxModule={exports:{}};const source=ts.transpileModule(fs.readFileSync(new URL('../src/lib/client/api.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{module:sandboxModule,exports:sandboxModule.exports,Headers,Date,TextEncoder,Uint8Array,process:{env:{}},window:{},localStorage:{getItem:()=>actor},crypto:{subtle:webcrypto.subtle,randomUUID:()=> 'operation-'+(++sequence)},sessionStorage:{getItem:(key:string)=>memory.get(key)||null,setItem:(key:string,value:string)=>memory.set(key,value),removeItem:(key:string)=>memory.delete(key)},fetch:async(url:string,options:RequestInit)=>{
  const action=JSON.parse(String(options.body)).action;const key=new Headers(options.headers).get('idempotency-key')||'';seen.push({url,actor,key,action});
  if(action==='abort')return new Response(acknowledgement,{status:200});if(!release)throw Error('response lost');return Response.json({ok:true});
 }});
 const api=(sandboxModule.exports as {apiFetch:(url:string,options:RequestInit)=>Promise<Response>}).apiFetch;
 const start={method:'POST',body:JSON.stringify({action:'start',caseIds:['one']})};
 await assert.rejects(()=>api('/api/debug/batch-tasks/a',start),/response lost/);await assert.rejects(()=>api('/api/debug/batch-tasks/b',start),/response lost/);actor='bob';await assert.rejects(()=>api('/api/debug/batch-tasks/a',start),/response lost/);actor='alice';
 await api('/api/debug/batch-tasks/a',{method:'POST',body:'{"action":"abort"}'});release=true;
 await api('/api/debug/batch-tasks/a',start);await api('/api/debug/batch-tasks/b',start);actor='bob';await api('/api/debug/batch-tasks/a',start);
 assert.ok(seen[0].key);if(acknowledgement==='{"ok":true}')assert.notEqual(seen[4].key,seen[0].key);else assert.equal(seen[4].key,seen[0].key);
 assert.equal(seen[5].key,seen[1].key);assert.equal(seen[6].key,seen[2].key);
 const stored=JSON.stringify([...memory.values()]);assert.equal(stored.includes('alice'),false);assert.equal(stored.includes('caseIds'),false);
});
