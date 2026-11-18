import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
test('original controls carry current credentials without altering SSE, FormData or cancellation',async()=>{
 const module={exports:{}};let key='current-owner';const calls:Array<{url:string;options:RequestInit}>=[];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/client/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module,exports:module.exports,Headers,Response,Date,process:{env:{}},window:{},localStorage:{getItem:()=>key},fetch:async(url:string,options:RequestInit)=>{calls.push({url,options});return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: first\n\ndata: done\n\n'));controller.close();}}),{headers:{'content-type':'text/event-stream'}});}});
 const api=module.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>;browserApiIdentityHeaders:(url:string)=>Record<string,string>};
 const form=new FormData();form.set('file',new Blob(['original bytes']),'skill.md');const abort=new AbortController();
 const response=await api.apiFetch('/api/skill-generator/chat',{method:'POST',body:form,signal:abort.signal});
 assert.equal(calls[0].options.body,form);assert.equal(calls[0].options.signal,abort.signal);assert.equal(new Headers(calls[0].options.headers).get('content-type'),null);assert.equal(new Headers(calls[0].options.headers).get('x-witty-api-key'),'current-owner');assert.equal(response.bodyUsed,false);assert.equal(await response.text(),'data: first\n\ndata: done\n\n');
 key='next-owner';assert.equal(api.browserApiIdentityHeaders('/api/skill-generator/chat')['x-witty-api-key'],'next-owner');assert.deepEqual(Object.keys(api.browserApiIdentityHeaders('https://example.invalid/api/skills')),[]);
 for(const url of ['/api/settings?user=spoofed','/api/settings/test']){await api.apiFetch(url);assert.equal(new Headers(calls.at(-1)!.options.headers).get('x-witty-api-key'),'next-owner');}
 for(const url of ['/api/settings-other','/api/settings/test/extra']){await api.apiFetch(url);assert.equal(new Headers(calls.at(-1)!.options.headers).get('x-witty-api-key'),null);}
 await api.apiFetch('/api/settings',{headers:{authorization:'Bearer readonly'}});assert.equal(new Headers(calls.at(-1)!.options.headers).get('x-witty-api-key'),null);
 await api.apiFetch('/api/skills',{headers:{authorization:'Bearer readonly'}});assert.equal(new Headers(calls.at(-1)!.options.headers).get('x-witty-api-key'),null);
 await api.apiFetch('https://example.invalid/api/skills');assert.equal(new Headers(calls.at(-1)!.options.headers).get('x-witty-api-key'),null);
});
