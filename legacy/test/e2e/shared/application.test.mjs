import assert from 'node:assert/strict';
import { test } from 'node:test';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { choosePort, stopProcesses } from './application.mjs';

test('test application selects a free port instead of taking an existing listener', async () => {
  const occupied = net.createServer();await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const port = await choosePort();
    assert.notEqual(port, occupied.address().port);
    const probe = net.createServer();await new Promise((resolve, reject) => { probe.once('error', reject);probe.listen(port, '127.0.0.1', resolve); });
    await new Promise(resolve => probe.close(resolve));
  } finally { await new Promise(resolve => occupied.close(resolve)); }
});

test('cleanup waits for owned stubborn children and leaves other processes alive', async () => {
  const start = async () => {
    const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise(resolve => child.stdout.once('data', resolve));return child;
  };
  const owned = await start(), other = await start();
  try { const result = await stopProcesses({ children: [owned] });assert.deepEqual(result.remaining, []);assert.doesNotThrow(() => process.kill(other.pid, 0)); }
  finally { for (const child of [owned, other]) try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
});

test('003 agent workspaces live outside the checkout and have no inherited git project',async()=>{const {prepareExternalWorkspace}=await import('./application.mjs');const root=prepareExternalWorkspace(process.cwd(),'workspace-test');assert.ok(!root.startsWith(process.cwd()+'/'));const {spawnSync}=await import('node:child_process');assert.notEqual(spawnSync('git',['-C',root,'rev-parse','--show-toplevel']).status,0);const fs=await import('node:fs');assert.equal(fs.statSync(root).mode&0o777,0o700);assert.throws(()=>prepareExternalWorkspace(process.cwd(),'../../../tools/unsafe'));});

test('003/004 platform agents receive the configured thinking/output budget and an external workspace',async()=>{
 const {prepareApplicationModelRuntime}=await import('./application.mjs');const {loadExecutionConfig}=await import('./config.mjs');const fs=await import('node:fs');
 const config=loadExecutionConfig({overrides:{model:{modelName:'configured-model',options:{thinking:{type:'disabled'},temperature:0}}}});
 for(const id of ['003','004']){
  const ctx={project:process.cwd(),runId:'controlled-model-'+id,selectedCase:id,executionConfig:config,key:'private-value-not-for-environment'},env={};prepareApplicationModelRuntime(ctx,env,12345);
  try{assert.ok(ctx.agentWorkspaceRoot&&!ctx.agentWorkspaceRoot.startsWith(process.cwd()+'/'));assert.equal(env.GENERAL_AGENT_WORKSPACE_ROOT,ctx.agentWorkspaceRoot);assert.equal(env.PORT,'12345');const profile=JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider['deepseek-official'];assert.equal(profile.options.timeout,config.timeouts.modelRequestMs);assert.deepEqual(profile.models['configured-model'].limit,{context:config.model.contextTokens,output:config.model.outputTokens});assert.deepEqual(profile.models['configured-model'].options,config.model.options);assert.ok(!env.OPENCODE_CONFIG_CONTENT.includes(ctx.key));}
  finally{if(ctx.agentWorkspaceRoot)fs.rmSync(ctx.agentWorkspaceRoot,{recursive:true,force:true});}
 }
});

test('production builds once per isolated suite and rejects stale or incomplete artifacts',async t=>{
 const application=await import('./application.mjs');assert.equal(typeof application.prepareProductionBuild,'function');
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-production-build-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const ctx={project:root,root:path.join(root,'case'),runId:'suite-001'},env={E2E_ISOLATED_CONTAINER:'1',E2E_SUITE_RUN_ID:'suite'};const calls=[];
 const run=async(bin,args,options)=>{calls.push({bin,args,env:options.env});fs.mkdirSync(path.join(root,'.next/standalone/.next'),{recursive:true});fs.writeFileSync(path.join(root,'.next/BUILD_ID'),'build-one');fs.writeFileSync(path.join(root,'.next/standalone/server.js'),'');fs.writeFileSync(path.join(root,'.next/standalone/.next/required-server-files.json'),'{}');fs.mkdirSync(path.join(root,'.next/static'),{recursive:true});fs.mkdirSync(path.join(root,'public'),{recursive:true});return {code:0};};
 const first=await application.prepareProductionBuild(ctx,env,{run});assert.equal(first.reused,false);assert.equal(calls.length,1);assert.ok(calls[0].args.includes('--webpack'));assert.equal(calls[0].env.NODE_ENV,'production');
 const second=await application.prepareProductionBuild({...ctx,runId:'suite-002'},env,{run});assert.equal(second.reused,true);assert.equal(second.buildId,first.buildId);assert.equal(calls.length,1);
 await assert.rejects(application.prepareProductionBuild(ctx,{...env,E2E_SUITE_RUN_ID:'different'},{run}),/fresh|different|stale/i);
 fs.unlinkSync(path.join(root,'.next/BUILD_ID'));await assert.rejects(application.prepareProductionBuild(ctx,env,{run}),/artifact|build/i);
 await assert.rejects(application.prepareProductionBuild(ctx,{...env,E2E_ISOLATED_CONTAINER:'0'},{run}),/isolated/i);
});

test('a failed production build cannot be reused as a successful build',async t=>{
 const application=await import('./application.mjs');assert.equal(typeof application.prepareProductionBuild,'function');
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-production-fail-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const ctx={project:root,root,runId:'failed-build'},env={E2E_ISOLATED_CONTAINER:'1'};
 await assert.rejects(application.prepareProductionBuild(ctx,env,{run:async()=>({code:1})}),/build/i);
 assert.equal(fs.existsSync(path.join(root,'exclude/core-e2e/production-build.json')),false);
});

test('production control server and Next routes share a free explicit dispatch port',async()=>{
 const application=await import('./application.mjs');assert.equal(typeof application.prepareProductionControlEnv,'function');
 const occupied=net.createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));
 try{const env={AGENT_INSIGHT_RAS_DISPATCH_PORT:String(occupied.address().port)},platformPort=await choosePort();const selected=await application.prepareProductionControlEnv(env,platformPort);assert.equal(env.AGENT_INSIGHT_RAS_DISPATCH_PORT,String(selected));assert.notEqual(selected,platformPort);assert.notEqual(selected,occupied.address().port);const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(selected,'127.0.0.1',resolve)});await new Promise(resolve=>probe.close(resolve));}
 finally{await new Promise(resolve=>occupied.close(resolve));}
});

test('a failed build blocks subsequent cases instead of rebuilding repeatedly',async t=>{
 const {prepareProductionBuild}=await import('./application.mjs'),fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path');const root=fs.mkdtempSync(path.join(os.tmpdir(),'e2e-production-once-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));let calls=0;const ctx={project:root,root,runId:'suite-001'},env={E2E_ISOLATED_CONTAINER:'1',E2E_SUITE_RUN_ID:'suite'},run=async()=>{calls++;return {code:1}};
 await assert.rejects(prepareProductionBuild(ctx,env,{run}),/build/i);await assert.rejects(prepareProductionBuild({...ctx,runId:'suite-002'},env,{run}),/build/i);assert.equal(calls,1);
});
