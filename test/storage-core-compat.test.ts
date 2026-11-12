import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';

process.env.AGENT_INSIGHT_STORAGE_CORE_URL = 'http://127.0.0.1:19000';
const legacyKey = 'isolated-legacy-key';
const delegated = 'api_' + 'C'.repeat(43);
const profile = { username:'core-owner', principal_id:'p1', workspace_id:'w', workspaces:[{workspace_id:'w',role:'owner'}] };
const root=fs.mkdtempSync(path.join(os.tmpdir(),'core-compat-'));
const identity=path.join(root,'identity.json');
function bindings(extra={}) {
 fs.writeFileSync(identity,JSON.stringify({version:1,core_origin:'http://127.0.0.1:19000',bindings:[{legacy_api_key_sha256:createHash('sha256').update(legacyKey).digest('hex'),legacy_username:'old-user',principal_id:'p1',workspace_id:'w',credential:delegated}],...extra}),{mode:0o600});
 process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=identity;
}
const resolveIdentity=async()=>({username:'old-user',apiKey:legacyKey});
const request=(query='',init:RequestInit={})=>new Request('http://localhost/api/observe/data'+query,{...init,headers:{'x-witty-api-key':legacyKey,...init.headers}});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));

test('existing list caller receives its original DTO through an authenticated explicit mapping',async()=>{
 bindings();const {handleCompatibleObserveData}=await import('../src/lib/storage-core/compat');let calls=0;
 const legacy={records:[{task_id:'old-task',upload_id:'old-execution',query:'Original query'}],page:1,pageSize:20,hasMore:false,canViewAllTraces:true};
 const result=await handleCompatibleObserveData(request('?user=forged&paginated=1&page=1&pageSize=20&listPart=records'),{resolveIdentity,fetcher:async(url,options)=>{
  calls++;assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+delegated);
  const u=new URL(String(url));if(u.pathname==='/v1/auth/me')return Response.json(profile);
  assert.equal(u.pathname,'/v1/compat/observe/data');assert.equal(u.searchParams.get('workspace_id'),'w');assert.equal(u.searchParams.has('user'),false);
  assert.equal(u.searchParams.get('listPart'),'records');return Response.json({value:legacy});
 }});
 assert.equal(result.status,200);assert.deepEqual(await result.json(),legacy);assert.equal(calls,2);
});

test('unverified legacy key or a mismatched target principal never reaches data queries',async()=>{
 bindings();const {handleCompatibleObserveData}=await import('../src/lib/storage-core/compat');let queries=0;
 for(const [resolver,principal] of [[async()=>({username:null,apiKey:legacyKey}),'p1'],[resolveIdentity,'wrong-principal']] as const){
  const response=await handleCompatibleObserveData(request('?user=admin'),{resolveIdentity:resolver,fetcher:async()=>{queries++;return Response.json({...profile,principal_id:principal});}});
  assert.equal(response.status,principal==='p1'?401:403);
 }
 assert.equal(queries,1);
});

test('unsafe or wrong-origin identity configuration fails closed without legacy database fallback',async()=>{
 const {handleCompatibleObserveData}=await import('../src/lib/storage-core/compat');let calls=0;
 bindings({core_origin:'http://127.0.0.1:19001'});
 let r=await handleCompatibleObserveData(request(),{resolveIdentity,fetcher:async()=>{calls++;throw Error('unreachable');}});assert.equal(r.status,503);
 bindings();fs.chmodSync(identity,0o644);
 r=await handleCompatibleObserveData(request(),{resolveIdentity,fetcher:async()=>{calls++;throw Error('unreachable');}});assert.equal(r.status,503);assert.equal(calls,0);fs.chmodSync(identity,0o600);
});

test('existing session and mutation contracts retain methods, resource IDs and error status',async()=>{
 bindings();const {handleCompatibleObserveData,handleCompatibleSession}=await import('../src/lib/storage-core/compat');
 const fetcher:typeof fetch=async(url,options)=>{
  const u=new URL(String(url));if(u.pathname==='/v1/auth/me')return Response.json(profile);
  if(u.pathname.endsWith('/session')){assert.equal(u.searchParams.get('taskId'),'original-task');assert.equal(u.searchParams.get('view'),'interaction');assert.equal(u.searchParams.get('index'),'12');return Response.json({value:{taskId:'original-task',index:12,interaction:{content:'same content'}}});}
  assert.equal(options?.method,'PATCH');assert.deepEqual(JSON.parse(String(options?.body)),{task_id:'original-task',label:'new title'});return new Response('do not leak credentials',{status:409});
 };
 const session=await handleCompatibleSession(new Request('http://localhost/api/observe/session?taskId=original-task&view=interaction&index=12&user=forged',{headers:{'x-witty-api-key':legacyKey}}),{resolveIdentity,fetcher});
 assert.equal(session.status,200);assert.equal((await session.json()).interaction.content,'same content');
 const mutation=await handleCompatibleObserveData(request('',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({task_id:'original-task',label:'new title'})}),{resolveIdentity,fetcher});assert.equal(mutation.status,409);assert.ok(!(await mutation.text()).includes('credentials'));
});

test('an existing collector key is verified and mapped without changing its OTLP wire acknowledgement',async()=>{
 bindings();const {handleCompatibleIngest}=await import('../src/lib/storage-core/compat');
 const packet={resourceSpans:[]};let accepted=false;
 const response=await handleCompatibleIngest(new Request('http://localhost/api/ingest/otel/v1/traces',{method:'POST',headers:{'content-type':'application/json','x-witty-api-key':legacyKey},body:JSON.stringify(packet)}),{resolveIdentity,fetcher:async(url,options)=>{
  const u=new URL(String(url));if(u.pathname==='/v1/auth/me')return Response.json(profile);
  assert.equal(u.pathname,'/v1/ingest/otlp');assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+delegated);assert.equal(new Headers(options?.headers).get('x-workspace-id'),'w');accepted=true;
  return Response.json({batch_id:'compat-batch',state:'accepted'});
 }});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{});assert.equal(response.headers.get('x-storage-batch-id'),'compat-batch');assert.equal(accepted,true);
});

test('existing tag DELETE requests have no JSON body and preserve their status',async()=>{
 bindings();const {handleCompatibleTags,handleCompatibleTraceTags}=await import('../src/lib/storage-core/compat');let calls=0;
 const fetcher:typeof fetch=async(url,options)=>{
  if(new URL(String(url)).pathname==='/v1/auth/me')return Response.json(profile);
  calls++;assert.equal(options?.method,'DELETE');assert.equal(options?.body,undefined);return Response.json({value:{success:true}});
 };
 const r=await handleCompatibleTags(request('',{method:'DELETE'}),'tag-id',{resolveIdentity,fetcher});assert.equal(r.status,200);
 const unlink=await handleCompatibleTraceTags(request('?tagId=t',{method:'DELETE'}),'original-execution',{resolveIdentity,fetcher});assert.equal(unlink.status,200);assert.equal(calls,2);
});

test('original Trace import/export retain bundle shape, filename and larger bounded bodies',async()=>{
 bindings();const compat=await import('../src/lib/storage-core/compat');
 assert.equal(typeof compat.handleCompatibleTransfer,'function');
 const bundle={format:'agent-insight.trace-bundle',version:1,rootExecutionId:'root /一',executions:[{content:'x'.repeat(4*1024*1024)}]};
 const fetcher:typeof fetch=async(url,options)=>{
  const u=new URL(String(url));if(u.pathname==='/v1/auth/me')return Response.json(profile);
  assert.equal(u.searchParams.has('user'),false);
  if(options?.method==='POST'){
   assert.equal(new Headers(options.headers).get('idempotency-key'),'same-receipt');
   assert.deepEqual(JSON.parse(String(options.body)),{bundle,fileName:'old.json',user:'spoofed'});
   return Response.json({value:{success:true,fileName:'old.json',rootExecutionId:'root /一'}});
  }
  assert.equal(u.searchParams.get('executionId'),'root /一');return Response.json({value:bundle});
 };
 const imported=await compat.handleCompatibleTransfer(request('',{method:'POST',headers:{'idempotency-key':'same-receipt'},body:JSON.stringify({bundle,fileName:'old.json',user:'spoofed'})}),'import',{resolveIdentity,fetcher});
 assert.equal(imported.status,200);assert.equal((await imported.json()).fileName,'old.json');
 const exported=await compat.handleCompatibleTransfer(request('?executionId='+encodeURIComponent('root /一')),'export',{resolveIdentity,fetcher});
 assert.equal(exported.status,200);assert.deepEqual(await exported.json(),bundle);
 assert.equal(exported.headers.get('content-disposition'),'attachment; filename="trace-root_.json"');
});
