import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

function route(file:string,mode=true){
 let oldCalls=0;let coreCalls=0;const exports:Record<string,unknown>={};
 const old=new Proxy(()=>{}, {get:()=>old,apply:()=>{oldCalls++;throw Error('Legacy storage touched');}});
 const deps:Record<string,unknown>={
  'next/server':{NextResponse:Response},
  '@/lib/storage-core/mode':{isStorageCoreEnabled:()=>mode},
  '@/lib/storage-core/diagnosis':{handleCoreDiagnosisSession:async(req:Request)=>{coreCalls++;return Response.json({session:null,messages:[],method:req.method});},handleCoreDiagnosisStream:async()=>{coreCalls++;return new Response('event: ready\ndata: {}\n\n',{headers:{'Content-Type':'text/event-stream'}});}},
  '@/lib/storage/prisma':{db:old,prismaRaw:old},
 };
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,require:(name:string)=>deps[name]??{},Response,Request,URL,TextEncoder,console});
 return {exports,counts:()=>({oldCalls,coreCalls})};
}
test('core session GET and POST keep original routes and never consult Prisma',async()=>{
 const h=route('src/app/api/fault/diagnosis/session/route.ts');
 for(const method of ['GET','POST']){
  const fn=h.exports[method] as (req:Request)=>Promise<Response>;
  const res=await fn(new Request('http://localhost/api/fault/diagnosis/session?executionId=task',{method,...(method==='POST'?{body:'{"executionId":"task","user":"forged"}'}:{})}));
  assert.equal(res.status,200);assert.deepEqual(await res.json(),{session:null,messages:[],method});
 }
 assert.deepEqual(h.counts(),{oldCalls:0,coreCalls:2});
});
test('core stream dispatches through the authorized pipeline before any legacy reads',async()=>{
 const h=route('src/app/api/fault/diagnosis/stream/route.ts');const fn=h.exports.POST as (req:Request)=>Promise<Response>;
 const res=await fn(new Request('http://localhost/api/fault/diagnosis/stream',{method:'POST',body:'{"executionId":"task","user":"forged","message":"why"}'}));
 assert.equal(res.headers.get('content-type'),'text/event-stream');assert.ok((await res.text()).includes('event: ready'));assert.deepEqual(h.counts(),{oldCalls:0,coreCalls:1});
});

test('original API transport supplies the existing Key to diagnosis without a new login state',async()=>{
 const exports:Record<string,unknown>={};const calls:RequestInit[]=[];let key:string|null='existing-key';
 const source=ts.transpileModule(fs.readFileSync('src/lib/client/api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(source,{exports,Headers,process:{env:{}},window:{},localStorage:{getItem:(name:string)=>name==='api_key'?key:null},fetch:async(_url:string,options:RequestInit)=>{calls.push(options);return new Response();}});
 const send=exports.apiFetch as (url:string,options?:RequestInit)=>Promise<Response>;
 await send('/api/fault/diagnosis/session?executionId=task');assert.equal(new Headers(calls.at(-1)?.headers).get('x-witty-api-key'),'existing-key');
 key='switched-key';await send('/api/fault/diagnosis/stream',{method:'POST',body:'{}'});assert.equal(new Headers(calls.at(-1)?.headers).get('x-witty-api-key'),'switched-key');
 key=null;await send('/api/fault/diagnosis/session');assert.equal(new Headers(calls.at(-1)?.headers).has('x-witty-api-key'),false);
 for(const path of ['/api/user-evaluators','/api/eval/settings','/api/evaluation/result']){key='existing-key';await send(path);assert.equal(new Headers(calls.at(-1)?.headers).get('x-witty-api-key'),'existing-key');}
 key=null;await send('/api/auth/apikey');assert.equal(new Headers(calls.at(-1)?.headers).has('x-witty-api-key'),false);
 key='current';await send('/api/fault/diagnosis/stream',{headers:{'x-witty-api-key':'explicit'}});assert.equal(new Headers(calls.at(-1)?.headers).get('x-witty-api-key'),'explicit');
});
