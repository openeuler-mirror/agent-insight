import { withCoreControlRequest } from '@/lib/storage-core/control-context';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {createIsolatedDatabase} from './helpers/isolated-database';
import {startIsolatedControlCore} from './helpers/isolated-control-core';

test('trusted core capture has an independent persistent per-actor runtime without plugin or OTEL credentials',async t=>{
 const fixture=createIsolatedDatabase();const coreStore=await startIsolatedControlCore(['bootstrap-owner']);const {bootstrapCoreControlUser}=await import('@/lib/storage-core/control-auth');const users:Record<string,{apiKey:string}>={};for(const user of ['core-fixture.actor','core-fixture_actor','group-stop-owner','group-stop-other'])users[user]=await bootstrapCoreControlUser(user);const binary=path.join(fixture.home,'fake-opencode');
 fs.writeFileSync(binary,`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const data=process.env.XDG_DATA_HOME;fs.mkdirSync(data,{recursive:true});
const marker=path.join(data,'session-history');if(!fs.existsSync(marker))fs.writeFileSync(marker,'preserved provider session');
const port=Number(process.argv[process.argv.indexOf('--port')+1]);
require('node:http').createServer((req,res)=>res.end(JSON.stringify({pid:process.pid,data,home:process.env.HOME,config:process.env.XDG_CONFIG_HOME,history:fs.readFileSync(marker,'utf8'),capture:process.env.AGENT_INSIGHT_OPENCODE_OTEL_ENABLE,key:process.env.AGENT_INSIGHT_API_KEY||null,host:process.env.AGENT_INSIGHT_HOST||null,sdkDisabled:process.env.OTEL_SDK_DISABLED,traces:process.env.OTEL_TRACES_EXPORTER}))).listen(port,'127.0.0.1');
`,{mode:0o700});
 const keys=['OPENCODE_BIN','AGENT_INSIGHT_API_KEY','AGENT_INSIGHT_HOST','AGENT_INSIGHT_OPENCODE_OTEL_ENABLE','OTEL_TRACES_EXPORTER'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{OPENCODE_BIN:binary,AGENT_INSIGHT_API_KEY:'fixture-inherited-upload-key',AGENT_INSIGHT_HOST:'http://fixture-upload',AGENT_INSIGHT_OPENCODE_OTEL_ENABLE:'true',OTEL_TRACES_EXPORTER:'otlp'});
 t.after(async()=>{for(const[key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await coreStore.dispose();fixture.dispose();});
 const manager=await import('../src/lib/engine/skill-generation/opencode-agent-cli/opencode-manager');
 const ensureServer=(options:Parameters<typeof manager.ensureOpencodeServer>[0])=>withCoreControlRequest(new Request('http://localhost/internal/opencode-test',{headers:{authorization:'Bearer '+users[options!.user!].apiKey}}),()=>manager.ensureOpencodeServer(options));
 const read=async(url:string):Promise<{pid:number;data:string;home:string;config:string;history:string;capture?:string;key:string|null;host:string|null;sdkDisabled?:string;traces?:string}> => (await fetch(url)).json();
 const user='core-fixture.actor';const other='core-fixture_actor';
 try{
  const normalUrl=await ensureServer({user});const normal=await read(normalUrl);
  const [coreUrl,duplicateUrl]=await Promise.all([ensureServer({user,captureMode:'core-recorded'}),ensureServer({user,captureMode:'core-recorded'})]);
  assert.equal(coreUrl,duplicateUrl);assert.notEqual(coreUrl,normalUrl);const core=await read(coreUrl);
  assert.notEqual(core.data,normal.data);assert.notEqual(core.home,normal.home);assert.notEqual(core.config,normal.config);
  assert.equal(core.capture,'false');assert.equal(core.key,null);assert.equal(core.host,null);assert.equal(core.sdkDisabled,'true');assert.equal(core.traces,'none');
  assert.equal(normal.capture,'true');assert.equal(normal.traces,'otlp');assert.ok(normal.key);
  assert.deepEqual(fs.readdirSync(path.join(core.home,'.opencode','plugins')),[]);
  const coreConfig=JSON.parse(fs.readFileSync(path.join(core.config,'opencode','opencode.json'),'utf8'));assert.deepEqual(coreConfig.plugin,[]);
  assert.equal(fs.statSync(path.join(core.config,'opencode','opencode.json')).mode&0o077,0);
  assert.equal(manager.killOpencodeForUser(user),0);
  const hash=manager.buildServerConfigHash('fixture-private-seed','fixture-upload-secret','core-recorded');
  assert.equal(hash.includes('fixture-private-seed'),false);assert.equal(hash.includes('fixture-upload-secret'),false);
  assert.equal(await ensureServer({user}),normalUrl);assert.equal((await read(normalUrl)).pid,normal.pid);
  assert.equal(await ensureServer({user,captureMode:'core-recorded'}),coreUrl);assert.equal((await read(coreUrl)).pid,core.pid);
  const frozenModel={providerID:'fixture-compatible',modelID:'model-a',apiKey:'fixture-model-secret-a',baseURL:'http://127.0.0.1:19099/v1',headers:{'X-Frozen':'a'}};
  const modelUrl=await ensureServer({user,captureMode:'core-recorded',frozenModel});const modelRuntime=await read(modelUrl);
  const modelConfig=JSON.parse(fs.readFileSync(path.join(modelRuntime.config,'opencode','opencode.json'),'utf8'));
  assert.equal(modelConfig.provider['fixture-compatible'].options.apiKey,frozenModel.apiKey);assert.equal(modelConfig.provider['fixture-compatible'].options.baseURL,frozenModel.baseURL);
  assert.deepEqual(modelConfig.provider['fixture-compatible'].options.headers,{authorization:'Bearer '+frozenModel.apiKey,'api-key':null,'x-api-key':null,'x-frozen':'a'});assert.ok(modelConfig.provider['fixture-compatible'].models['model-a']);
  assert.equal(modelConfig.provider['fixture-compatible'].npm,'@ai-sdk/openai-compatible');assert.equal(Object.keys(modelConfig.provider).length,1);

  const nativeModel={...frozenModel,providerID:'insight-native',protocol:'anthropic' as const,apiKey:'',baseURL:'https://gateway.test/team',headers:{'X-Company-Key':'fixture-company'}};
  const nativeRuntime=await read(await ensureServer({user,captureMode:'core-recorded',frozenModel:nativeModel}));
  const nativeConfig=JSON.parse(fs.readFileSync(path.join(nativeRuntime.config,'opencode','opencode.json'),'utf8')).provider['insight-native'];
  assert.equal(nativeConfig.npm,'@ai-sdk/anthropic');assert.equal(nativeConfig.options.baseURL,'https://gateway.test/team/v1');
  assert.equal(nativeConfig.options.headers['x-company-key'],'fixture-company');assert.equal(nativeConfig.options.headers.authorization,null);assert.equal(nativeConfig.options.headers['x-api-key'],null);
  const modelB={...frozenModel,modelID:'model-b',apiKey:'fixture-model-secret-b'};
  const secondModel=await read(await ensureServer({user,captureMode:'core-recorded',frozenModel:modelB}));
  assert.notEqual(secondModel.pid,modelRuntime.pid);assert.notEqual(secondModel.config,modelRuntime.config);assert.equal(secondModel.data,modelRuntime.data);assert.equal(secondModel.data,core.data);
  assert.equal(await ensureServer({user,captureMode:'core-recorded',frozenModel}),modelUrl);assert.equal((await read(modelUrl)).pid,modelRuntime.pid);
  assert.equal((await read(coreUrl)).pid,core.pid);assert.equal((await read(normalUrl)).pid,normal.pid);assert.equal(manager.killOpencodeForUser(user),0);
  const ephemeral=await manager.runWithEphemeralOpencodeServer({user,isolateHome:true,captureMode:'core-recorded',frozenModel},async url=>{const instance=await read(url);const config=JSON.parse(fs.readFileSync(path.join(instance.config,'opencode','opencode.json'),'utf8'));assert.equal(config.provider['fixture-compatible'].options.apiKey,frozenModel.apiKey);assert.equal(instance.capture,'false');assert.notEqual(instance.data,core.data);return instance;});
  assert.equal(fs.existsSync(path.dirname(ephemeral.data)),false);
  const another=await read(await ensureServer({user:other,captureMode:'core-recorded'}));assert.notEqual(another.data,core.data);assert.notEqual(another.home,core.home);
  await t.test('stop terminates wrapper descendants without stopping another actor or capture variant',async()=>{
   const worker=path.join(fixture.home,'owned-group-worker.js');const wrapper=path.join(fixture.home,'owned-group-wrapper');const log=path.join(fixture.home,'owned-group-pids.jsonl');
   fs.writeFileSync(worker,`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({wrapper:process.ppid,child:process.pid})+'\\n');const port=Number(process.argv[2]);require('node:http').createServer((req,res)=>res.end(JSON.stringify({wrapper:process.ppid,child:process.pid}))).listen(port,'127.0.0.1');`);
   fs.writeFileSync(wrapper,`#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const port=process.argv[process.argv.indexOf('--port')+1];spawn(process.execPath,[${JSON.stringify(worker)},port],{stdio:['ignore','inherit','inherit']});process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),150));`,{mode:0o700});
   const groupUser='group-stop-owner';const groupOther='group-stop-other';process.env.OPENCODE_BIN=wrapper;
   const groupRead=async(url:string):Promise<{wrapper:number;child:number}> => (await fetch(url)).json();
   const exists=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
   try {
    const normalURL=await ensureServer({user:groupUser});const normalGroup=await groupRead(normalURL);
    const ownedURL=await ensureServer({user:groupUser,captureMode:'core-recorded',frozenModel});const owned=await groupRead(ownedURL);
    const otherURL=await ensureServer({user:groupOther,captureMode:'core-recorded',frozenModel});const otherGroup=await groupRead(otherURL);
    await manager.stopOpencodeServer(groupUser,{captureMode:'core-recorded'});
    assert.equal(exists(owned.child),false,'native worker must be gone after awaited core stop');
    assert.equal(exists(-owned.wrapper),false,'the complete owned process group must be gone');
    assert.deepEqual(await groupRead(normalURL),normalGroup);assert.deepEqual(await groupRead(otherURL),otherGroup);
    await manager.stopOpencodeServer(groupUser);assert.equal(exists(normalGroup.child),false);assert.deepEqual(await groupRead(otherURL),otherGroup);
    assert.equal((await read(normalUrl)).pid,normal.pid);
   } finally {
    await manager.stopOpencodeServer(groupUser);await manager.stopOpencodeServer(groupUser,{captureMode:'core-recorded'});await manager.stopOpencodeServer(groupOther,{captureMode:'core-recorded'});
    if(fs.existsSync(log))for(const line of fs.readFileSync(log,'utf8').trim().split('\n')){const record=JSON.parse(line) as {wrapper:number;child:number};if(exists(record.child)){try{process.kill(-record.wrapper,'SIGKILL');}catch{}}}
    process.env.OPENCODE_BIN=binary;
   }
  });
  await manager.stopOpencodeServer(user,{captureMode:'core-recorded'});
  assert.equal((await read(normalUrl)).pid,normal.pid);
  const restarted=await read(await ensureServer({user,captureMode:'core-recorded'}));assert.equal(restarted.data,core.data);assert.equal(restarted.history,'preserved provider session');
 }finally{await manager.stopOpencodeServer(user);await manager.stopOpencodeServer(user,{captureMode:'core-recorded'});await manager.stopOpencodeServer(other,{captureMode:'core-recorded'});}
});
