import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
test('durable background actors restore, retain current gates and coexist with explicit legacy mappings',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'background-restore-unit-'));const variables=['AGENT_INSIGHT_STORAGE_CORE_URL','AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE','AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE','AGENT_INSIGHT_HOME','DATABASE_URL'];const previous=variables.map(key=>process.env[key]);
 const token='api_'+'u'.repeat(43),origin='http://127.0.0.1:49021',controller=path.join(directory,'controller');await writeFile(controller,'a'.repeat(64),{mode:0o600});
 process.env.AGENT_INSIGHT_STORAGE_CORE_URL=origin;process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=controller;process.env.AGENT_INSIGHT_HOME=directory;process.env.DATABASE_URL='file:'+path.join(directory,'unused.db');delete process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE;
 let active=true,write=true,execute=true;const calls:string[]=[];const row={user_record_id:'user',token,principal:'owner',workspace:'w',username:'Mixed.Owner',principalUsername:'mixed.owner'};
 const fetcher:typeof fetch=async(input,options)=>{
  const url=new URL(String(input)),body=options?.body?JSON.parse(String(options.body)):{};calls.push(url.pathname+':'+(body.action||''));
  if(url.pathname==='/v1/compat/platform-control-bootstrap'){
   const {signControllerPayload}=await import('../src/lib/storage-core/controller');assert.equal(new Headers(options?.headers).get('x-storage-controller-proof'),signControllerPayload('a'.repeat(64),'platform-control-bootstrap/v1','platform-background','platform-background',String(options?.body)));assert.equal(new Headers(options?.headers).get('authorization'),null);
   if(body.action==='background_actors')return Response.json({value:{actors:active&&write?[row]:[],failures:active&&write?[]:[active?403:401],failure_owners:active&&write?[]:[{username:row.username,principal:row.principal,workspace:row.workspace,status:active?403:401}]}});
   assert.equal(body.action,'background_actor');assert.equal(body.credential_sha256,createHash('sha256').update(token).digest('hex'));return active&&write?Response.json({value:row}):Response.json({error:'inactive'},{status:active?403:401});
  }
  if(url.pathname==='/v1/auth/me')return active?Response.json({principal_id:'owner',username:'mixed.owner',legacy_username:'Mixed.Owner',workspace_id:'w',workspaces:[{workspace_id:'w'}]}):Response.json({error:'inactive'},{status:401});
  if(url.pathname==='/v1/compat/collector-source'){
   if(!active||!write||body.action==='model_scope'&&!execute)return Response.json({error:'forbidden'},{status:403});
   return Response.json({value:{authorized:true,operation:body.operation,principal_id:'owner',workspace_id:'w'}});
  }
  throw new Error('Unexpected private route '+url.pathname);
 };
 try{
  const api=await import('../src/lib/storage-core/compat');const collector=await import('../src/lib/storage-core/collector-identity');const {collectorPrivate}=await import('../src/lib/storage-core/collector-entry');
  const first=(await api.configuredCoreBackgroundActors({fetcher},true)).actors[0];assert.equal(first.username,'Mixed.Owner');assert.equal(first.principalUsername,'mixed.owner');assert.ok(api.isVerifiedCoreBackgroundActor(first));assert.equal(api.isVerifiedCoreBackgroundActor({...first}),false);
  const second=(await api.configuredCoreBackgroundActors({fetcher},true)).actors[0];assert.notEqual(first,second);await api.revalidateConfiguredCoreBackgroundActor(second,{fetcher});
  const identity=await collector.collectorIdentityForBackgroundActor(second,{operation:'snapshot'},{fetcher});await collectorPrivate(identity,'model_scope');
  const {withCoreConfiguredExperiments,requireCoreExperimentContext}=await import('../src/lib/storage-core/experiments');await withCoreConfiguredExperiments(second,async()=>assert.equal(requireCoreExperimentContext().actor.username,'Mixed.Owner'),{fetcher});
  execute=false;await assert.rejects(collectorPrivate(identity,'model_scope'),(error:any)=>error.status===403);execute=true;
  write=false;assert.equal((await api.configuredCoreBackgroundActors({fetcher},true)).actors.length,0);await assert.rejects(api.revalidateConfiguredCoreBackgroundActor(second,{fetcher}),(error:any)=>error.status===403);write=true;
  active=false;await assert.rejects(api.revalidateConfiguredCoreBackgroundActor(second,{fetcher}),(error:any)=>error.status===401);await assert.rejects(api.configuredCoreBackgroundActorForUser('Mixed.Owner',{fetcher}),(error:any)=>error.status===401);await assert.rejects(api.configuredCoreBackgroundActorForUser('unknown',{fetcher}),(error:any)=>error.status===403);active=true;
  const mapping=path.join(directory,'identity.json');await writeFile(mapping,JSON.stringify({version:1,core_origin:origin,bindings:[{legacy_username:'legacy-owner',legacy_api_key_sha256:'b'.repeat(64),principal_id:'owner',workspace_id:'w',credential:token}]}),{mode:0o600});process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=mapping;
  const mapped=(await api.configuredCoreBackgroundActors({fetcher},true)).actors;assert.equal(mapped.length,1);assert.equal(mapped[0].username,'legacy-owner');await api.revalidateConfiguredCoreBackgroundActor(mapped[0],{fetcher});
  await withCoreConfiguredExperiments(mapped[0],async()=>assert.equal(requireCoreExperimentContext().actor.username,'legacy-owner'),{fetcher});
  active=false;await assert.rejects(api.configuredCoreBackgroundActorForUser('legacy-owner',{fetcher}),(error:any)=>error.status===401);await assert.rejects(api.configuredCoreBackgroundActorForUser('unmapped-owner',{fetcher}),(error:any)=>error.status===403);
  const unavailable:typeof fetch=(input,options)=>new URL(String(input)).pathname==='/v1/auth/me'?Promise.resolve(Response.json({error:'unavailable'},{status:503})):fetcher(input,options);await assert.rejects(api.configuredCoreBackgroundActorForUser('legacy-owner',{fetcher:unavailable}),(error:any)=>error.status===503);await assert.rejects(api.configuredCoreBackgroundActorForUser('unmapped-owner',{fetcher:unavailable}),(error:any)=>error.status===403);active=true;
  await writeFile(mapping,JSON.stringify({version:1,core_origin:origin,bindings:[]}),{mode:0o600});await assert.rejects(api.revalidateConfiguredCoreBackgroundActor(mapped[0],{fetcher}),(error:any)=>error.status===403);
  assert.ok(calls.some(value=>value.endsWith(':background_actor')));
 }finally{for(let index=0;index<variables.length;index++){const value=previous[index];if(value===undefined)delete process.env[variables[index]];else process.env[variables[index]]=value;}}
});
