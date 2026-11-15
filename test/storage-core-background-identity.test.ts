import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {createIsolatedDatabase} from './helpers/isolated-database';
const database=createIsolatedDatabase();

test('configured background scope binds the real principal and the private legacy Skill/model owner in its RPC closure',async()=>{
 const {configuredCoreBackgroundActors,isVerifiedCoreBackgroundActor}=await import('@/lib/storage-core/compat');
 const {withCoreConfiguredExperiments,requireCoreExperimentContext}=await import('@/lib/storage-core/experiments');
 const {prisma}=await import('@/lib/storage/prisma');
 const old={file:process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE,url:process.env.AGENT_INSIGHT_STORAGE_CORE_URL,mode:process.env.AGENT_INSIGHT_TRACE_STORAGE,controller:process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE};
 const file=path.join(database.home,'identity.json'),controller=path.join(database.home,'controller-key');const token='api_'+'K'.repeat(43);
 process.env.AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE=file;process.env.AGENT_INSIGHT_STORAGE_CORE_URL='http://127.0.0.1:19000';process.env.AGENT_INSIGHT_TRACE_STORAGE='core';process.env.AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE=controller;
 writeFileSync(controller,'a'.repeat(64),{mode:0o600});writeFileSync(file,JSON.stringify({version:1,core_origin:'http://127.0.0.1:19000',bindings:[{legacy_username:'old-model-owner',legacy_api_key_sha256:'a'.repeat(64),principal_id:'real-principal',workspace_id:'w',credential:token}]}),{mode:0o600});
 await prisma.skill.create({data:{id:'private-skill',name:'private-skill',user:'old-model-owner',versions:{create:{version:1,content:'# Private original version'}}}});
 let authenticated=true;let writes=0;
 const fetcher:typeof fetch=async(url,options)=>{
  const parsed=new URL(String(url));assert.equal(new Headers(options?.headers).get('authorization'),'Bearer '+token);
  if(parsed.pathname==='/v1/auth/me')return authenticated?Response.json({principal_id:'real-principal',username:'core-owner',workspaces:[{workspace_id:'w'}]}):Response.json({error:'revoked'},{status:401});
  assert.equal(parsed.pathname,'/v1/compat/experiments');assert.equal(parsed.searchParams.get('workspace_id'),'w');assert.ok(new Headers(options?.headers).get('x-storage-controller-proof'));writes++;return Response.json({value:{accepted:true}});
 };
 try{
  const {actors}=await configuredCoreBackgroundActors({fetcher});const actor=actors[0];assert.equal(isVerifiedCoreBackgroundActor(actor),true);assert.equal(isVerifiedCoreBackgroundActor({...actor}),false);
  await assert.rejects(withCoreConfiguredExperiments({...actor},async()=>{}, {fetcher}),error=>(error as {status:number}).status===403);
  await withCoreConfiguredExperiments(actor,async()=>{
   const context=requireCoreExperimentContext();assert.equal(context.actor.username,'old-model-owner');assert.equal(context.actor.principal,'real-principal');
   assert.deepEqual(await context.rpc('start',{experiment_id:'exp',config:{derived_skill_ids:['private-skill'],derived_skill_versions:{'private-skill':[1]}}}),{accepted:true});
  },{fetcher});assert.equal(writes,1);
  authenticated=false;await assert.rejects(withCoreConfiguredExperiments(actor,async()=>{throw Error('revoked actor ran');},{fetcher}),error=>(error as {status:number}).status===401);assert.equal(writes,1);
 }finally{await prisma.$disconnect();for(const [key,value] of Object.entries({AGENT_INSIGHT_STORAGE_CORE_IDENTITY_FILE:old.file,AGENT_INSIGHT_STORAGE_CORE_URL:old.url,AGENT_INSIGHT_TRACE_STORAGE:old.mode,AGENT_INSIGHT_STORAGE_CORE_CONTROLLER_FILE:old.controller})){if(value===undefined)delete process.env[key];else process.env[key]=value;}database.dispose();}
});
