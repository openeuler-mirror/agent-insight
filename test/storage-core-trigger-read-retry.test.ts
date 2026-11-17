import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const retry=()=>Response.json({error:'state changed'},{status:409,headers:{'x-storage-retry':'trigger-read-changed'}});
function fixture(respond:(attempt:number,options:RequestInit)=>Promise<Response>|Response){
 const fixtureModule={exports:{}};let key='alice-key',user='legacy-alice';const calls:RequestInit[]=[];
 vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/client/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,Headers,Response,Date,TextEncoder,Uint8Array,AbortController,Error,setTimeout,clearTimeout,process:{env:{}},window:{},localStorage:{getItem:(name:string)=>name==='api_key'?key:name==='user_id'?user:null},sessionStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},crypto:webcrypto,fetch:async(_url:string,options:RequestInit)=>{calls.push(options);return respond(calls.length,options);}});
 return {api:(fixtureModule.exports as {apiFetch:(url:string,options?:RequestInit)=>Promise<Response>}).apiFetch,calls,setIdentity:(nextKey:string,nextUser=user)=>{key=nextKey;user=nextUser;}};
}
function originalReload(api:(url:string)=>Promise<Response>,initial:unknown[]){
 const source=fs.readFileSync('src/app/(main)/skill-eval/trigger/[skillName]/page.tsx','utf8'),start=source.indexOf('const reload = useCallback('),suffix='}, [user, skillName, selectedVersion, selectedSetId]);',end=source.indexOf(suffix,start);assert.ok(start>0&&end>start);
 let runs=initial,error:unknown;const fixtureModule={exports:{}};
 vm.runInNewContext(ts.transpileModule(source.slice(start,end+suffix.length)+'\nexports.reload=reload;',{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:fixtureModule,exports:fixtureModule.exports,useCallback:(fn:unknown)=>fn,user:'legacy-alice',skillName:'checking',selectedVersion:0,selectedSetId:null,URLSearchParams,apiFetch:(url:string)=>url.includes('/runs?')?api(url):Promise.resolve(Response.json(url.includes('/settings')?{configs:[]}:{versions:[],set:null})),pickEditableSet:()=>null,setLoading:()=>{},setErrorMsg:(value:unknown)=>{error=value;},setVersions:()=>{},setSet:()=>{},setSelectedSetId:()=>{},setRuns:(value:unknown[])=>{runs=value;},setSelectedRunId:()=>{},setModelConfigs:()=>{},setActiveConfigId:()=>{},setDraftConfigId:()=>{}});
 return {reload:(fixtureModule.exports as {reload:()=>Promise<void>}).reload,runs:()=>runs,error:()=>error};
}

test('original first reload retains running discovery through the exact transient Trigger GET conflict',async()=>{
 const f=fixture(attempt=>attempt===1?retry():Response.json({runs:[{id:'new',status:'running'}]}));const ui=originalReload(url=>f.api(url),[]);await ui.reload();assert.equal(f.calls.length,2);assert.equal((ui.runs()[0] as {status:string}).status,'running');assert.equal(ui.error(),null);assert.equal(new Headers(f.calls[1].headers).get('x-witty-api-key'),'alice-key');
});
test('exhausted typed conflicts enter original reload catch and keep the previous list',async()=>{
 const f=fixture(()=>retry()),known=[{id:'known',status:'running'}],ui=originalReload(url=>f.api(url),known);await ui.reload();assert.equal(f.calls.length,4);assert.equal(ui.runs(),known);assert.ok(ui.error());
});
for(const status of [409,403,404])test('ordinary Trigger GET '+status+' is not retried and cannot become an empty history',async()=>{
 const f=fixture(()=>Response.json({error:'not transient'},{status})),known=[{id:'known',status:'running'}],ui=originalReload(url=>f.api(url),known);await ui.reload();assert.equal(f.calls.length,1);assert.equal(ui.runs(),known);assert.ok(ui.error());
});
test('Trigger retry respects Abort and current account changes without replaying stale credentials',async()=>{
 const controller=new AbortController();const aborted=fixture(()=>{setTimeout(()=>controller.abort(),10);return retry();});await assert.rejects(aborted.api('/api/skill-eval/trigger/checking/runs',{signal:controller.signal}));assert.equal(aborted.calls.length,1);
 const changed=fixture(()=>{changed.setIdentity('bob-key','bob');return retry();});await assert.rejects(changed.api('/api/skill-eval/trigger/checking/runs'));assert.equal(changed.calls.length,1);
});
test('an account change during a retry rejects the stale response',async()=>{
 const f=fixture(attempt=>{if(attempt===1)return retry();f.setIdentity('bob-key','bob');return Response.json({runs:[{id:'stale-alice',status:'running'}]});});await assert.rejects(f.api('/api/skill-eval/trigger/checking/runs'));assert.equal(f.calls.length,2);
});

test('mutation conflicts and other GET routes retain their original response contracts',async()=>{
 const f=fixture(()=>retry());const response=await f.api('/api/skill-eval/trigger/checking/run',{method:'POST',body:'{}'});assert.equal(response.status,409);assert.equal(f.calls.length,1);const root=await f.api('/api/skill-eval/trigger/checking');assert.equal(root.status,409);assert.equal(f.calls.length,2);
});
