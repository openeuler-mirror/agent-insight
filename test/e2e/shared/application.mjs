import {internalModelConfig} from './model-config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { boundedAppEnv } from './app-environment.mjs';
import { poll, command } from './runtime.mjs';

async function portIsFree(port) {
  return new Promise(resolve => { const probe = net.createServer();probe.once('error', () => resolve(false));probe.listen(port, '0.0.0.0', () => probe.close(() => resolve(true))); });
}

export async function choosePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject);probe.listen(0, '0.0.0.0', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

export function deepSeekSmokeConfig(ctx){return internalModelConfig(ctx);}

export function prepareExternalWorkspace(project,runId){
  assert.match(runId,/^[a-z0-9-]+$/);const directory=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),`agent-insight-e2e-${runId}-`)));fs.chmodSync(directory,0o700);
  assert.ok(!directory.startsWith(fs.realpathSync(project)+path.sep));const git=spawnSync('git',['-C',directory,'rev-parse','--show-toplevel'],{encoding:'utf8'});if(git.error)throw git.error;assert.notEqual(git.status,0,'Test Agent workspace inherited a parent Git repository');return directory;
}

export function prepareApplicationModelRuntime(ctx,env,port){
 if(!['003','004','005'].includes(ctx.selectedCase))return;
 ctx.agentWorkspaceRoot=prepareExternalWorkspace(ctx.project,ctx.runId);env.GENERAL_AGENT_WORKSPACE_ROOT=ctx.agentWorkspaceRoot;env.PORT=String(port);env.OPENCODE_DISABLE_MODELS_FETCH='true';env.OPENCODE_CONFIG_CONTENT=JSON.stringify(deepSeekSmokeConfig(ctx));
}

export async function startApplication(ctx) {
  const port = Number(new URL(ctx.baseUrl).port);
  assert.ok(Number.isInteger(port) && port > 0, 'An explicit test port is required');
  assert.ok(await portIsFree(port), `Port ${port} is occupied; refusing to invoke the restart script or terminate its owner`);
  ctx.port = port;
  const appHome = path.join(ctx.root, 'app');
  if(ctx.persistentAppHome&&!fs.existsSync(appHome))fs.symlinkSync(ctx.persistentAppHome,appHome,'dir');
  const hostHome = path.join(ctx.root, 'app-host');
  fs.mkdirSync(appHome, { recursive: true, mode: 0o700 });fs.mkdirSync(hostHome, { recursive: true, mode: 0o700 });
  const env = { ...process.env, HOME: hostHome, AGENT_INSIGHT_HOME: appHome, AGENT_INSIGHT_PORT: String(port), DATABASE_URL: `file:${path.join(appHome, 'data/witty_insight.db')}`, LOGIN_MODE: 'standalone', NODE_OPTIONS: '--max-old-space-size=4096' };
  prepareApplicationModelRuntime(ctx,env,port);
  for (const name of ['AGENT_INSIGHT_DATA_DIR', 'DB_HOST', 'ORGANIZATION_MODE', 'DEFAULT_MODEL_1_API_KEY', 'DEFAULT_MODEL_2_API_KEY']) delete env[name];
  if(ctx.selectedCase==='006'){
    ctx.agentWorkspaceRoot=prepareExternalWorkspace(ctx.project,ctx.runId);
    fs.mkdirSync(path.join(appHome,'client'),{recursive:true,mode:0o700});
    const bin=path.join(ctx.root,'server-bin');fs.mkdirSync(bin,{recursive:true});fs.symlinkSync(process.env.E2E_PYTHON||'/opt/homebrew/bin/python3',path.join(bin,'python3'));
    env.PATH=bin+path.delimiter+process.env.PATH;env.AGENT_INSIGHT_CLIENT_SOURCE='local';env.PIP_CACHE_DIR=path.join(ctx.project,'exclude/core-e2e/cache/pip');
    const installed=await command(process.execPath,['-e',"if(!require('./scripts/install-ras-client.js').installFaultInjection())process.exit(1)"],{cwd:ctx.project,env,timeout:300000,log:path.join(ctx.root,'private/server-fi-install.log')});
    assert.equal(installed.code,0,'Server FI Python installation failed');env.AGENT_INSIGHT_FI_PYTHON=JSON.parse(fs.readFileSync(path.join(appHome,'client/config.json'))).fiPython;ctx.fiPython=env.AGENT_INSIGHT_FI_PYTHON;env.AGENT_INSIGHT_RAS_PYTHON=ctx.fiPython;
    const rasDependencies=await command(ctx.fiPython,['-m','pip','install',path.join(ctx.project,'agent_ras'),'--disable-pip-version-check'],{cwd:ctx.project,env,timeout:180000,log:path.join(ctx.root,'private/server-ras-install.log')});assert.equal(rasDependencies.code,0,'Server RAS catalog dependencies unavailable');
    env.PORT=String(port);env.OPENCODE_DISABLE_MODELS_FETCH='true';
  }
  const fd = fs.openSync(path.join(ctx.root, 'private', 'startup.log'), 'a', 0o600);
  ctx.appProcess = spawn('bash', ['scripts/develop_start.sh'], { cwd: ctx.project, env:boundedAppEnv(ctx.root,env,ctx.executionConfig?.resources), detached: true, stdio: ['ignore', fd, fd] });fs.closeSync(fd);
  const startup = new Promise((resolve, reject) => { ctx.appProcess.once('error', reject);ctx.appProcess.once('close', code => code === 0 ? resolve() : reject(new Error(`Application startup failed (${code}); see private/startup.log`))); });
  await Promise.race([startup, new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('Application startup deadline exceeded')), 180000);t.unref(); })]);
  await poll(async () => { try { const r = await fetch(ctx.baseUrl + '/login', { signal: AbortSignal.timeout(30000) });return r.status; } catch { return null; } }, code => code === 200, 120000);
  ctx.appHome = appHome;
  return { fiPython:ctx.fiPython, applicationRoot: appHome, agentWorkspaceRoot:ctx.agentWorkspaceRoot, modelRuntimeProfile:['003','004','005'].includes(ctx.selectedCase)?deepSeekSmokeConfig(ctx):undefined, database: path.join(appHome, 'data/witty_insight.db'), loginMode: 'standalone', startup: 'scripts/develop_start.sh', port };
}

function descendants(root) {
  const rows = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).stdout.split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const owned = new Set([root]);let changed = true;
  while (changed) { changed = false;for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid);changed = true; } }
  return [...owned].reverse();
}

export async function stopProcesses(ctx) {
  const roots = (ctx.children || []).map(child => child.pid);
  if (ctx.appProcess) {
    const socket = spawnSync('lsof', [`-tiTCP:${ctx.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).map(Number);
    for (const pid of socket) {
      const cwd = spawnSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).stdout;
      assert.ok(cwd.split('\n').includes('n' + ctx.project), 'Refusing to stop application whose working directory is not this isolated checkout');
      roots.push(pid);
    }
    roots.push(ctx.appProcess.pid);
  }
  const owned = new Set(roots.flatMap(descendants));
  for (const pid of roots) { try { process.kill(-pid, 'SIGTERM'); } catch {} }
  for (const pid of owned) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await new Promise(resolve => setTimeout(resolve, 1200));
  for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  let remaining = [];
  for (let attempt = 0; attempt < 50; attempt++) {
    remaining = [];
    for (const pid of owned) { try { process.kill(pid, 0);const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();if (state && !state.startsWith('Z')) remaining.push(pid); } catch {} }
    if (!remaining.length) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.deepEqual(remaining, [], 'Owned processes still alive after cleanup');
  if (ctx.appProcess) assert.ok(await portIsFree(ctx.port), 'Application port was not released');
  return { stoppedProcessCount: owned.size, remaining, applicationStopped: !!ctx.appProcess, globalServicesModified: false };
}
