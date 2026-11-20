import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {existsSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {createIsolatedDatabase} from './helpers/isolated-database';

const database=createIsolatedDatabase();
const token='api_'+'A'.repeat(43),otherToken='api_'+'B'.repeat(43),readOnly='api_'+'R'.repeat(43);
const previous={origin:process.env.AGENT_INSIGHT_STORAGE_CORE_URL,mapping:process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE,controller:process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE};
process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';
process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=path.join(database.home,'collector-identity.json');
process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=path.join(database.home,'controller-key');writeFileSync(process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE,'a'.repeat(64),{mode:0o600});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const binding=(username='legacy-owner',credential=token,principal='principal-a',workspace='w')=>({legacy_username:username,legacy_api_key_sha256:hash('legacy-key'),principal_id:principal,workspace_id:workspace,credential});
const mapping=(bindings= [binding()])=>writeFileSync(process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE!,JSON.stringify({version:1,core_origin:'http://127.0.0.1:19000',bindings}),{mode:0o600});
const request=(headers:HeadersInit={},query='')=>new Request('http://localhost/api/ingest/upload'+query,{method:'POST',headers,body:JSON.stringify({user:'forged',authenticatedUser:true})});
const status=(expected:number)=>(error:unknown)=>(error as {status?:number}).status===expected;
const devices=new Map<string,{clientId:string;user:string;revoked:boolean}>();
let enabled=true,canWrite=true;const requests:string[]=[];
const fetcher:typeof fetch=async(url,options)=>{
 const parsed=new URL(String(url)),credential=new Headers(options?.headers).get('authorization');requests.push(parsed.pathname);
 if(parsed.pathname==='/v1/compat/platform-control-capability'){
  assert.ok(new Headers(options?.headers).has('x-storage-controller-proof'));const payload=JSON.parse(String(options?.body));assert.equal(payload.action,'identity');
  const device=devices.get(payload.capability.credential_hash);if(!device||device.revoked)return Response.json({error:'invalid device'},{status:401});
  return Response.json({value:{principal:'principal-a',workspace:'w',username:device.user,client_id:device.clientId}});
 }
 if(parsed.pathname==='/v1/compat/platform-control-bootstrap'){assert.ok(new Headers(options?.headers).has('x-storage-controller-proof'));return Response.json({value:{actors:[],failures:[]}});}
 if(!enabled)return Response.json({error:'revoked'},{status:401});
 if(parsed.pathname==='/v1/auth/me')return Response.json({principal_id:credential==='Bearer '+otherToken?'principal-b':'principal-a',username:'core-owner',workspace_id:'w',workspaces:[{workspace_id:'w',role:'member'},{workspace_id:'other',role:'member'}]});
 assert.equal(parsed.pathname,'/v1/compat/collector-source');
 const payload=JSON.parse(String(options?.body));assert.equal(payload.action,'scope');assert.ok(['snapshot','complete'].includes(payload.operation));
 if(!canWrite||credential==='Bearer '+readOnly)return Response.json({error:'write denied'},{status:403});
 return Response.json({value:{authorized:true,operation:payload.operation,principal_id:credential==='Bearer '+otherToken?'principal-b':'principal-a',workspace_id:parsed.searchParams.get('workspace_id')}});
};
const options={fetcher,resolveIdentity:async(input:Request)=>({username:input.headers.get('x-witty-api-key')==='legacy-key'?'legacy-owner':null,apiKey:input.headers.get('x-witty-api-key')==='legacy-key'?'legacy-key':null})};
async function api(){
 assert.ok(existsSync('src/lib/storage-core/collector-identity.ts'),'trusted collector identity helper must exist');
 return import('@/lib/storage-core/collector-identity');
}
async function device(user='legacy-owner'){
 const clientId='fixture-client-'+devices.size,deviceCredential='dc_fixture_'+devices.size;devices.set(hash(deviceCredential),{clientId,user,revoked:false});return {clientId,deviceCredential};
}
test.beforeEach(()=>{mapping();enabled=true;canWrite=true;requests.length=0;});
test.after(async()=>{const {prismaRaw}=await import('@/lib/storage/prisma');await prismaRaw.$disconnect();if(previous.origin===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=previous.origin;if(previous.mapping===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=previous.mapping;if(previous.controller===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE;else process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=previous.controller;database.dispose();});

test('body identity and boolean auth stamps cannot create a collector scope',async()=>{const a=await api();await assert.rejects(a.resolveCoreCollectorIdentity(request(),{framework:'opencode',operation:'snapshot'},options),status(401));assert.equal(requests.length,0);});
test('mapped collector uses actual principal and preserves the separate legacy owner without serializing secrets',async()=>{
 const a=await api();const identity=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':'legacy-key'}),{operation:'snapshot'},options);
 assert.equal(identity.principal,'principal-a');assert.equal(identity.workspace,'w');assert.equal(identity.username,'legacy-owner');assert.equal(identity.principalUsername,'core-owner');assert.equal(identity.clientId,undefined);assert.equal(a.isVerifiedCoreCollectorIdentity(identity),true);assert.equal(a.isVerifiedCoreCollectorIdentity({...identity}),false);assert.equal(JSON.stringify(identity).includes(token),false);assert.equal(JSON.stringify(identity).includes('legacy-key'),false);
 await a.withCoreCollectorIdentity(identity,async(actor)=>{assert.equal(actor.token,token);assert.equal(actor.username,'legacy-owner');});
 await assert.rejects(a.withCoreCollectorIdentity({...identity},async()=>{}),status(403));
});
test('direct API bearer and x-witty credentials require live write capability rather than workspace role',async()=>{
 const a=await api();for(const headers of [{'x-witty-api-key':token},{authorization:'Bearer '+token}] as Record<string,string>[]){const identity=await a.resolveCoreCollectorIdentity(request(headers),{operation:'complete'},options);assert.equal(identity.principal,'principal-a');}
 await assert.rejects(a.resolveCoreCollectorIdentity(request({'x-witty-api-key':readOnly}),{operation:'snapshot'},options),status(403));
 await assert.rejects(a.resolveCoreCollectorIdentity(request({authorization:'Bearer session_'+'S'.repeat(43)}),{operation:'snapshot'},options),status(403));
});
test('revalidation refuses credential revocation and lost capability before yielding the private actor',async()=>{
 const a=await api();const identity=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token}),{operation:'snapshot'},options);enabled=false;await assert.rejects(identity.revalidate(),status(401));enabled=true;canWrite=false;await assert.rejects(a.withCoreCollectorIdentity(identity,async()=>assert.fail('unauthorized actor yielded')),status(403));
});
test('Core-verified device credential maps its owner and binds only its verified client',async()=>{
 const a=await api(),d=await device();const identity=await a.resolveCoreCollectorIdentity(request({authorization:'Bearer '+d.deviceCredential,'x-agent-insight-client-id':d.clientId}),{framework:'opencode',clientId:d.clientId,operation:'snapshot'},options);assert.equal(identity.username,'legacy-owner');assert.equal(identity.principal,'principal-a');assert.equal(identity.clientId,d.clientId);
 devices.get(hash(d.deviceCredential))!.revoked=true;await assert.rejects(identity.revalidate(),status(401));
});
test('both valid credentials must identify the same principal and workspace',async()=>{
 const a=await api(),d=await device();const same=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token,authorization:'Bearer '+d.deviceCredential}),{framework:'opencode',operation:'snapshot'},options);assert.equal(same.clientId,d.clientId);assert.equal(same.username,'legacy-owner');assert.equal(same.principalUsername,'core-owner');
 await assert.rejects(a.resolveCoreCollectorIdentity(request({'x-witty-api-key':otherToken,authorization:'Bearer '+d.deviceCredential}),{framework:'opencode',operation:'snapshot'},options),status(403));
 await assert.rejects(a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token,authorization:'Bearer '+d.deviceCredential},'?workspace_id=other'),{framework:'opencode',operation:'snapshot'},options),status(403));
});
test('invalid device plus valid API key is accepted without a forged device binding',async()=>{
 const a=await api();const identity=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token,authorization:'Bearer dc_invalid','x-agent-insight-client-id':'forged'}),{framework:'opencode',clientId:'forged',operation:'snapshot'},options);assert.equal(identity.clientId,undefined);
});
test('invalid API key plus a valid registered device uses the current mapped device owner',async()=>{
 const a=await api(),d=await device();const identity=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':'bad-key',authorization:'Bearer '+d.deviceCredential}),{framework:'opencode',operation:'snapshot'},options);assert.equal(identity.clientId,d.clientId);assert.equal(identity.principal,'principal-a');
});
test('unavailable IAM is never downgraded to an invalid credential or bypassed by another credential',async()=>{
 const a=await api(),d=await device();const unavailable={...options,fetcher:async()=>Response.json({error:'unavailable'},{status:503})};await assert.rejects(a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token,authorization:'Bearer '+d.deviceCredential}),{framework:'opencode',operation:'snapshot'},unavailable),status(503));
});
test('device owner mappings reject ambiguity, missing mapping and unavailable matching candidates',async()=>{
 const a=await api(),d=await device();const input=request({authorization:'Bearer '+d.deviceCredential});
 mapping([binding(),binding('legacy-owner',otherToken,'principal-b')]);await assert.rejects(a.resolveCoreCollectorIdentity(input,{framework:'opencode',operation:'snapshot'},options),status(403));
 mapping([]);await assert.rejects(a.resolveCoreCollectorIdentity(input,{framework:'opencode',operation:'snapshot'},options),status(403));
 mapping([binding()]);enabled=false;await assert.rejects(a.resolveCoreCollectorIdentity(input,{framework:'opencode',operation:'snapshot'},options),status(401));
});
test('unrelated revoked mappings do not block the verified device owner',async()=>{
 const a=await api(),d=await device();mapping([binding(),binding('other-owner',otherToken,'principal-b')]);const selective={...options,fetcher:async(url:RequestInfo|URL,init?:RequestInit)=>new Headers(init?.headers).get('authorization')==='Bearer '+otherToken?Response.json({error:'revoked'},{status:401}):fetcher(url,init)};const identity=await a.resolveCoreCollectorIdentity(request({authorization:'Bearer '+d.deviceCredential}),{framework:'opencode',operation:'snapshot'},selective);assert.equal(identity.username,'legacy-owner');assert.equal(requests.filter(v=>v==='/v1/auth/me').length,1);
});
test('reported client mismatch fails even though body metadata cannot grant a binding',async()=>{
 const a=await api(),d=await device();await assert.rejects(a.resolveCoreCollectorIdentity(request({authorization:'Bearer '+d.deviceCredential}),{framework:'opencode',clientId:'forged',operation:'snapshot'},options),status(403));
});
test('proxy provider Authorization is excluded from user authentication when explicitly classified',async()=>{
 const a=await api();await assert.rejects(a.resolveCoreCollectorIdentity(request({authorization:'Bearer '+token}),{authorizationKind:'provider',operation:'snapshot'},options),status(401));const identity=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token,authorization:'Bearer provider-secret'}),{authorizationKind:'provider',operation:'snapshot'},options);assert.equal(identity.principal,'principal-a');
});

test('an issued identity cannot be rebound to another configured core origin',async()=>{
 const a=await api();const identity=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token}),{operation:'snapshot'},options);const before=requests.length;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19001';try{await assert.rejects(identity.revalidate(),status(503));assert.equal(requests.length,before);}finally{process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';}
});
test('device-only identity cannot be silently rebound to another mapping principal or workspace',async()=>{
 const a=await api(),d=await device();const identity=await a.resolveCoreCollectorIdentity(request({authorization:'Bearer '+d.deviceCredential}),{framework:'opencode',operation:'snapshot'},options);mapping([binding('legacy-owner',otherToken,'principal-b')]);await assert.rejects(identity.revalidate(),status(403));
});
test('workspace headers are honored and conflicting duplicate selections are rejected',async()=>{
 const a=await api();const identity=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token,'x-workspace-id':'other'}),{operation:'snapshot'},options);assert.equal(identity.workspace,'other');await assert.rejects(a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token,'x-workspace-id':'other'},'?workspace_id=w'),{operation:'snapshot'},options),status(403));await assert.rejects(a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token},'?workspace_id=w&workspace_id=other'),{operation:'snapshot'},options),status(400));
});
test('a valid device credential cannot authenticate other frameworks or a provider authorization channel',async()=>{
 const a=await api(),d=await device();for(const input of [{framework:'codex',operation:'snapshot' as const},{framework:'opencode',operation:'snapshot' as const,authorizationKind:'provider' as const}])await assert.rejects(a.resolveCoreCollectorIdentity(request({authorization:'Bearer '+d.deviceCredential}),input,options),status(401));
});

test('origin drift during an awaited profile response cannot transmit the credential to another core',async()=>{
 const a=await api();const origins:string[]=[];const drifting={...options,fetcher:async(url:RequestInfo|URL,init?:RequestInit)=>{origins.push(new URL(String(url)).origin);const result=await fetcher(url,init);if(new URL(String(url)).pathname==='/v1/auth/me')process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19001';return result;}};
 try{await assert.rejects(a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token}),{operation:'snapshot'},drifting),status(503));assert.deepEqual(origins,['http://127.0.0.1:19000']);}finally{process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';}
});
test('the private callback receives a pinned transport that rejects origin changes before credential transmission',async()=>{
 const a=await api();const identity=await a.resolveCoreCollectorIdentity(request({'x-witty-api-key':token}),{operation:'snapshot'},options);
 await a.withCoreCollectorIdentity(identity,async(actor,pinned)=>{assert.ok(pinned?.fetcher,'private collector callback requires its pinned transport');const before=requests.length;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19001';try{const {requestCore}=await import('@/lib/storage-core/server');await assert.rejects(requestCore('/v1/compat/collector-source?workspace_id=w',{token:actor.token,method:'POST',body:JSON.stringify({action:'scope',operation:'snapshot'})},pinned.fetcher),status(503));assert.equal(requests.length,before);}finally{process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';}});
});

test('device authentication uses the pinned transport and rejects origin drift before binding an owner',async()=>{
 const a=await api(),d=await device();
 const drifting={...options,fetcher:async(url:RequestInfo|URL,init?:RequestInit)=>{
  const response=await fetcher(url,init);
  if(new URL(String(url)).pathname==='/v1/compat/platform-control-capability')process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19001';
  return response;
 }};
 try{
  await assert.rejects(a.resolveCoreCollectorIdentity(request({authorization:'Bearer '+d.deviceCredential}),{framework:'opencode',operation:'snapshot'},drifting),status(503));
  assert.deepEqual(requests,['/v1/compat/platform-control-capability']);
 }finally{process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';}
});
