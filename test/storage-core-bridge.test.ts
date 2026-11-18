import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = new URL('../src/lib/storage-core/server.ts', import.meta.url);
async function api() {
  assert.ok(fs.existsSync(source), 'core server bridge must exist');
  return import('../src/lib/storage-core/server');
}
const token = 'session_' + 'A'.repeat(43);
const profile = {username:'alice',principal_id:'p1',display_name:'Alice',project_id:'default',workspace_id:'w',workspaces:[{workspace_id:'w',name:'Workspace',role:'owner'}]};
process.env.AGENT_INSIGHT_STORAGE_CORE_URL = 'http://127.0.0.1:19000';
const request = (path:string, init:RequestInit={}) => new Request('http://localhost:3000'+path, init);

test('core target rejects non-loopback, credentials, paths and query', async () => {
  const m=await api();
  for(const value of ['https://example.com','http://127.0.0.1.attacker.test','http://user:pass@localhost:1234','http://localhost:1234/base','http://localhost:1234/?q=x','http://localhost:1234/#x','file:///tmp/a']) assert.throws(()=>m.coreServiceOrigin(value));
  assert.equal(m.coreServiceOrigin('http://127.0.0.1:1234/'),'http://127.0.0.1:1234');
});

test('core read ignores spoofed legacy identity and forwards only verified credential and allowed filters', async () => {
  const m=await api();let called=false;
  const response=await m.handleCoreList(request('/api/observe/data?workspace_id=w&search=test&user=admin&traceUser=admin&bucket=secret',{headers:{authorization:'Bearer '+token,'x-witty-api-key':'legacy-admin'}}),async(url,init)=>{
    called=true;const target=new URL(String(url)); assert.equal(target.pathname,'/v1/traces');assert.equal(target.searchParams.get('workspace_id'),'w');assert.equal(target.searchParams.has('user'),false);assert.equal(target.searchParams.has('bucket'),false);
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+token);assert.equal(new Headers(init?.headers).has('x-witty-api-key'),false);assert.equal(init?.redirect,'error');return Response.json({items:[],next_cursor:null});
  });assert.equal(response.status,200);assert.equal(called,true);
});

test('core reads never authenticate using local user headers or legacy keys', async()=>{
  const m=await api();let calls=0;const response=await m.handleCoreList(request('/api/observe/data?user=admin',{headers:{'x-witty-api-key':'legacy','x-user-id':'admin'}}),async()=>{calls++;throw Error('unexpected');});assert.equal(response.status,401);assert.equal(calls,0);
});

test('unknown session action and core mutations fail without fallback',async()=>{
  const m=await api();let calls=0;const response=await m.handleCoreSession(request('/api/observe/session?action=delete&trace_id=t',{headers:{authorization:'Bearer '+token}}),async()=>{calls++;throw Error('unexpected');});assert.equal(response.status,501);assert.equal(calls,0);assert.equal(m.coreUnsupported().status,501);
});

test('upstream errors and redirect responses never expose secrets or report success',async()=>{
 const m=await api();for(const upstream of [new Response('password=secret',{status:500}),new Response(null,{status:302,headers:{location:'http://example.com'}})]) {const r=await m.handleCoreList(request('/api/observe/data',{headers:{authorization:'Bearer '+token}}),async()=>upstream);assert.equal(r.status,502);assert.equal((await r.text()).includes('secret'),false);}
});

test('auth login requires same origin and keeps session token only in HttpOnly cookie',async()=>{
 const m=await api();let calls=0;const fetcher:typeof fetch=async()=>{calls++;return Response.json({session_token:token,profile});};
 const denied=await m.handleCoreAuth(request('/api/storage-core/auth',{method:'POST',headers:{origin:'http://evil.example','content-type':'application/json'},body:JSON.stringify({username:'alice',password:'secret'})}),fetcher);assert.equal(denied.status,403);assert.equal(calls,0);
 const r=await m.handleCoreAuth(request('/api/storage-core/auth',{method:'POST',headers:{origin:'http://localhost:3000','content-type':'application/json'},body:JSON.stringify({username:'alice',password:'secret'})}),fetcher);
 assert.equal(r.status,200);const cookie=r.headers.get('set-cookie')!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.match(cookie,/Max-Age=86400/);assert.deepEqual(await r.json(),profile);assert.equal(cookie.includes(token),true);
 assert.notEqual(m.coreCookieName('http://127.0.0.1:1'),m.coreCookieName('http://127.0.0.1:2'));
});

test('logout preserves cookie on backend failure and clears after revocation',async()=>{
 const m=await api();const headers={origin:'http://localhost:3000',cookie:m.coreCookieName()+'='+token};
 let r=await m.handleCoreAuth(request('/api/storage-core/auth',{method:'DELETE',headers}),async()=>new Response(null,{status:503}));assert.equal(r.status,503);assert.equal(r.headers.has('set-cookie'),false);
 r=await m.handleCoreAuth(request('/api/storage-core/auth',{method:'DELETE',headers}),async()=>Response.json({ok:true}));assert.equal(r.status,200);assert.match(r.headers.get('set-cookie')!,/Max-Age=0/);
});

test('bounded upstream JSON rejects oversized or malformed responses',async()=>{
 const m=await api();for(const body of ['{bad','x'.repeat(4*1024*1024+1)]){const r=await m.handleCoreList(request('/api/observe/data',{headers:{authorization:'Bearer '+token}}),async()=>new Response(body));assert.equal(r.status,502);}
});

test('core ingest accepts only api credentials and returns OTLP ack after durable batch',async()=>{
 const m=await api();const apiToken='api_'+'B'.repeat(43);let calls=0;const fetcher:typeof fetch=async(url,init)=>{calls++;assert.equal(new URL(String(url)).pathname,'/v1/ingest/otlp');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer '+apiToken);return Response.json({batch_id:'batch',state:'accepted',trace_ids:['trace'],duplicate:false});};
 const denied=await m.handleCoreIngest(request('/api/ingest/otel/v1/traces?api_key='+apiToken,{method:'POST',headers:{'content-type':'application/json'},body:'{}'}),fetcher);assert.equal(denied.status,401);assert.equal(calls,0);
 const r=await m.handleCoreIngest(request('/api/ingest/otel/v1/traces',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+apiToken},body:'{"resourceSpans":[]}'}),fetcher);assert.equal(r.status,200);assert.equal(r.headers.get('x-storage-batch-id'),'batch');assert.deepEqual(await r.json(),{});
});

test('core ingest bounds actual request bytes, decoded gzip, and serialized internal JSON',async()=>{
 const m=await api();const headers={'content-type':'application/json',authorization:'Bearer api_'+'B'.repeat(43)};let calls=0;
 const r=await m.handleCoreIngest(request('/api/ingest/otel/v1/traces',{method:'POST',headers,body:' '.repeat(8*1024*1024+1)}),async()=>{calls++;throw Error('unexpected');});assert.equal(r.status,413);assert.equal(calls,0);
});

test('mode-off routes keep legacy entrypoints and core mode branches before identity resolution',async()=>{
 const {isStorageCoreEnabled}=await import('../src/lib/storage-core/mode');assert.equal(isStorageCoreEnabled({}),false);assert.equal(isStorageCoreEnabled({NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE:'core'}),true);
 for(const file of ['observe/data','observe/session','ingest/otel/v1/traces']) {const text=fs.readFileSync(new URL('../src/app/api/'+file+'/route.ts',import.meta.url),'utf8');assert.match(text,/isStorageCoreEnabled\(\)/);assert.match(text,file==='ingest/otel/v1/traces'?/handleCoreCollectorTraces/:/handleCompatible/);assert.ok(text.indexOf('if (isStorageCoreEnabled())')<text.indexOf('await resolveUser(')||!text.includes('await resolveUser('));}
});

test('auth responses whitelist profile fields and never expose nested credential fields',async()=>{
 const m=await api();const r=await m.handleCoreAuth(request('/api/storage-core/auth',{headers:{authorization:'Bearer '+token}}),async()=>Response.json({...profile,session_token:token,password_hash:'secret'}));assert.equal(r.status,200);const body=await r.json();assert.equal(body.session_token,undefined);assert.equal(body.password_hash,undefined);assert.deepEqual(body,profile);
});

test('public mode flag uses a directly compiled public environment variable',()=>{
 const text=fs.readFileSync(new URL('../src/lib/storage-core/mode.ts',import.meta.url),'utf8');assert.match(text,/process\.env\.NEXT_PUBLIC_AGENT_INSIGHT_TRACE_STORAGE/);
});

test('failed or unknown durable batch states cannot produce a successful OTLP ack',async()=>{
 const m=await api();for(const state of ['failed','pending','unknown']) {const r=await m.handleCoreIngest(request('/api/ingest/otel/v1/traces',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer api_'+'B'.repeat(43)},body:'{}'}),async()=>Response.json({batch_id:'batch',state}));assert.equal(r.status,502);}
});

test('trace path segments cannot escape the traces endpoint',async()=>{
 const m=await api();let calls=0;const r=await m.handleCoreSession(request('/api/observe/session?trace_id=..',{headers:{authorization:'Bearer '+token}}),async()=>{calls++;return Response.json({});});assert.equal(r.status,400);assert.equal(calls,0);
});

test('gzip and protobuf OTLP use the same durable ingestion path and bounded expansion',async()=>{
 const {gzipSync}=await import('node:zlib');const m=await api();const headers={authorization:'Bearer api_'+'B'.repeat(43)};let calls=0;
 const fetcher:typeof fetch=async(_url,init)=>{calls++;assert.deepEqual(JSON.parse(String(init?.body)).resourceSpans ?? [],[]);return Response.json({batch_id:'batch',state:'indexed'});};
 const gz=await m.handleCoreIngest(request('/api/ingest/otel/v1/traces',{method:'POST',headers:{...headers,'content-type':'application/json','content-encoding':'gzip'},body:gzipSync('{"resourceSpans":[]}')}),fetcher);assert.equal(gz.status,200);
 const proto=await m.handleCoreIngest(request('/api/ingest/otel/v1/traces',{method:'POST',headers:{...headers,'content-type':'application/x-protobuf'},body:new Uint8Array()}),fetcher);assert.equal(proto.status,200);assert.equal((await proto.arrayBuffer()).byteLength,0);assert.equal(proto.headers.get('content-type'),'application/x-protobuf');
 const bomb=await m.handleCoreIngest(request('/api/ingest/otel/v1/traces',{method:'POST',headers:{...headers,'content-type':'application/json','content-encoding':'gzip'},body:gzipSync(' '.repeat(8*1024*1024+1))}),fetcher);assert.equal(bomb.status,413);
 const internal=await m.handleCoreIngest(request('/api/ingest/otel/v1/traces',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({large:'x'.repeat(4*1024*1024)})}),fetcher);assert.equal(internal.status,413);assert.equal(calls,2);
});

test('session pagination allowlist forwards no caller-selected trace bucket',async()=>{
 const m=await api();let actual='';const r=await m.handleCoreSession(request('/api/observe/session?action=payload&workspace_id=w&trace_id=t&span_id=s&revision=2&section=input&after_chunk=3&limit=4&trace_bucket=20260101',{headers:{authorization:'Bearer '+token}}),async(url)=>{actual=String(url);return Response.json({chunks:[],complete:true});});assert.equal(r.status,200);const target=new URL(actual);assert.equal(target.pathname,'/v1/traces/t/spans/s/payload');assert.equal(target.searchParams.has('trace_bucket'),false);assert.equal(target.searchParams.get('after_chunk'),'3');
});

test('real loopback HTTP bridge follows neither redirects nor raw error bodies',async()=>{
 const {createServer}=await import('node:http');const m=await api();let hits=0;
 const server=createServer((req,res)=>{hits++;assert.equal(req.headers.authorization,'Bearer '+token);res.writeHead(302,{location:'/leak'});res.end();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address && typeof address!=='string');const previous=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;
 try {process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:'+address.port;const r=await m.handleCoreList(request('/api/observe/data',{headers:{authorization:'Bearer '+token}}));assert.equal(r.status,502);assert.equal(hits,1);} finally {process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous;await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});

test('upstream JSON rejects invalid UTF-8 without replacing signed evidence text',async()=>{
 const m=await api();const raw=Buffer.from('{"query":"XXX"}');raw[raw.indexOf('XXX')]=0xff;
 const response=await m.handleCoreList(request('/api/observe/data',{headers:{authorization:'Bearer '+token}}),async()=>new Response(raw));
 assert.equal(response.status,502);
 assert.doesNotMatch(await response.text(),/\uFFFD/);
});
