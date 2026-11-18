import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

function client(){
 const exports:Record<string,unknown>={},calls:Array<{url:string;headers:Headers}>=[];let key:string|null='alice-key';
 const source=ts.transpileModule(readFileSync('src/lib/client/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,Headers,process:{env:{NEXT_PUBLIC_URL_PREFIX:'/prefix'}},window:{},localStorage:{getItem:(name:string)=>name==='api_key'?key:null},fetch:async(url:string,options:RequestInit)=>{calls.push({url,headers:new Headers(options.headers)});return new Response();}});
 return {send:exports.apiFetch as (url:string,options?:RequestInit)=>Promise<Response>,calls,key:(value:string|null)=>{key=value;}};
}
for(const [path,method] of [['/api/modelconfig/pricing?user=forged','GET'],['/api/skills/by-name/checking/optimization-points?user=forged','GET'],['/api/skills/by-name/checking/optimization-points/resolve','PATCH']])test(`original browser transport authenticates ${method} ${path} across account changes`,async()=>{
 const c=client();await c.send(path,{method});assert.equal(c.calls.at(-1)!.headers.get('x-witty-api-key'),'alice-key');assert.equal(c.calls.at(-1)!.url,'/prefix'+path);
 c.key('bob-key');await c.send(path,{method});assert.equal(c.calls.at(-1)!.headers.get('x-witty-api-key'),'bob-key');
 c.key(null);await c.send(path,{method});assert.equal(c.calls.at(-1)!.headers.has('x-witty-api-key'),false);
 c.key('current');await c.send(path,{method,headers:{'x-witty-api-key':'explicit'}});assert.equal(c.calls.at(-1)!.headers.get('x-witty-api-key'),'explicit');
});
test('Skill control mutations transport the current actor without granting an unrelated API path',async()=>{const c=client();await c.send('/api/skills/by-name/checking/optimization-points/resolve-other',{method:'PATCH'});assert.equal(c.calls.at(-1)!.headers.get('x-witty-api-key'),'alice-key');await c.send('/api/skills-other',{method:'PATCH'});assert.equal(c.calls.at(-1)!.headers.has('x-witty-api-key'),false);});
test('the new authentication transport does not broaden configuration PUT or unrelated paths',async()=>{
 const c=client();for(const [path,method] of [['/api/modelconfig/pricing','PUT'],['/api/modelconfig/pricing-other','GET'],['https://example.com/api/modelconfig/pricing','GET']]){await c.send(path,{method});assert.equal(c.calls.at(-1)!.headers.has('x-witty-api-key'),false);}
});
