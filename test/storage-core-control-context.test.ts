import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
const token=(name:string)=>'api_'+name.repeat(43);
const profile=async(input:RequestInfo|URL,init?:RequestInit)=>{
 const headers=new Headers(init?.headers),name=headers.get('authorization')?.includes(token('a'))?'alice':'bob';
 return Response.json({principal_id:name,username:name,workspace_id:'w',workspaces:[{workspace_id:'w',role:'member'}]});
};
test('static control context is bound to actual requests and remains isolated across concurrent actors',async()=>{
 assert.ok(existsSync('src/lib/storage-core/control-context.ts'),'request-scoped control context required');
 const api=await import('../src/lib/storage-core/control-context');
 const before=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:32109';
 try{
  assert.throws(()=>api.requireCoreControlContext(),(e:any)=>e.status===503);
  const run=async(name:string,char:string)=>api.withCoreControlRequest(new Request('http://isolated/api/settings',{headers:{authorization:'Bearer '+token(char)}}),async()=>{
   await new Promise(resolve=>setTimeout(resolve,name==='alice'?8:1));
   assert.equal(api.requireCoreControlContext().actor.username,name);if(name==='alice'){const inner=await api.withCoreControlRequest(new Request('http://isolated/api/settings',{headers:{authorization:'Bearer '+token('b')}}),async()=>api.requireCoreControlContext().actor.username,{fetcher:profile as typeof fetch});assert.equal(inner,'bob');assert.equal(api.requireCoreControlContext().actor.username,'alice');}return api.requireCoreControlContext().actor.token;
  },{fetcher:profile as typeof fetch});
  assert.deepEqual(await Promise.all([run('alice','a'),run('bob','b')]),[token('a'),token('b')]);
  assert.equal(api.getCoreControlContext(),undefined);
  await assert.rejects(api.withVerifiedCoreControlActor({principal:'alice',workspace:'w',username:'alice',principalUsername:'alice',token:token('a')} as any,async()=>{}),(e:any)=>e.status===403);
 }finally{if(before===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=before;}
});

test('nested typed contexts retain execution restrictions only for the same verified actor',async()=>{
 const api=await import('../src/lib/storage-core/control-context');
 const actor={token:token('a'),username:'alice',principal:'alice',workspace:'w'};
 const before=process.env.AGENT_INSIGHT_STORAGE_CORE_URL;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:32109';
 try{await api.runWithCoreControlActor(actor,{},async()=>{
  api.requireCoreControlContext().capabilities=['execute'];
  await api.runWithCoreControlActor(actor,{},async()=>assert.deepEqual(api.requireCoreControlContext().capabilities,['execute']));
  await api.runWithCoreControlActor({...actor,token:token('b')},{},async()=>assert.equal(api.requireCoreControlContext().capabilities,undefined));
  await api.runWithCoreControlActor(actor,{},async()=>assert.equal(api.requireCoreControlContext().capabilities,undefined),'collector-preparation');
 });}finally{if(before===undefined)delete process.env.AGENT_INSIGHT_STORAGE_CORE_URL;else process.env.AGENT_INSIGHT_STORAGE_CORE_URL=before;}
});
