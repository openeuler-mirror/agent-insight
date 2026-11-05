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

test('005 agent workspaces live outside the checkout and have no inherited git project',async()=>{const {prepareExternalWorkspace}=await import('./application.mjs');const root=prepareExternalWorkspace(process.cwd(),'workspace-test');assert.ok(!root.startsWith(process.cwd()+'/'));const {spawnSync}=await import('node:child_process');assert.notEqual(spawnSync('git',['-C',root,'rev-parse','--show-toplevel']).status,0);const fs=await import('node:fs');assert.equal(fs.statSync(root).mode&0o777,0o700);assert.throws(()=>prepareExternalWorkspace(process.cwd(),'../../../tools/unsafe'));});

test('003–005 platform agents receive the configured thinking/output budget and an external workspace',async()=>{
 const {prepareApplicationModelRuntime}=await import('./application.mjs');const {loadExecutionConfig}=await import('./config.mjs');const fs=await import('node:fs');
 const config=loadExecutionConfig({overrides:{model:{modelName:'configured-model',options:{thinking:{type:'disabled'},temperature:0}}}});
 for(const id of ['003','004','005']){
  const ctx={project:process.cwd(),runId:'controlled-model-'+id,selectedCase:id,executionConfig:config,key:'private-value-not-for-environment'},env={};prepareApplicationModelRuntime(ctx,env,12345);
  try{assert.ok(ctx.agentWorkspaceRoot&&!ctx.agentWorkspaceRoot.startsWith(process.cwd()+'/'));assert.equal(env.GENERAL_AGENT_WORKSPACE_ROOT,ctx.agentWorkspaceRoot);assert.equal(env.PORT,'12345');const profile=JSON.parse(env.OPENCODE_CONFIG_CONTENT).provider['deepseek-official'];assert.equal(profile.options.timeout,config.timeouts.modelRequestMs);assert.deepEqual(profile.models['configured-model'].limit,{context:config.model.contextTokens,output:config.model.outputTokens});assert.deepEqual(profile.models['configured-model'].options,config.model.options);assert.ok(!env.OPENCODE_CONFIG_CONTENT.includes(ctx.key));}
  finally{if(ctx.agentWorkspaceRoot)fs.rmSync(ctx.agentWorkspaceRoot,{recursive:true,force:true});}
 }
});
