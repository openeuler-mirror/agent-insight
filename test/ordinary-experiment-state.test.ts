import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createOrdinaryExperimentStore } = require('../scripts/ordinary-experiment-state.cjs');

test('普通实验取消状态持久化，未启动可确认，旧执行缺少证据不伪造完成', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-experiment-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createOrdinaryExperimentStore(root);
  assert.deepEqual(await store.reconcile('cmd_old'), { confirmed: false, reason: 'RUN_STATE_UNAVAILABLE' });
  store.accept('cmd_prestart');
  store.requestCancellation('cmd_prestart');
  assert.deepEqual(await createOrdinaryExperimentStore(root).reconcile('cmd_prestart'), { confirmed: true });
  assert.equal(store.cancellation('cmd_prestart').confirmed, true);
  assert.equal(store.state('cmd_prestart').stage, 'terminal');
  store.accept('cmd_launching');
  store.launching('cmd_launching');
  assert.deepEqual(await store.reconcile('cmd_launching'), { confirmed: false, reason: 'RUN_PROCESS_UNCONFIRMED' });
});

test('普通实验重启恢复会清理已记录的进程组，并确认取消', { skip: process.platform === 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-experiment-recover-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already stopped */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const options = { processIdentity: (pid: number) => pid === 999999 ? null : 'same process' };
  const store = createOrdinaryExperimentStore(root, options);
  store.accept('cmd_running');
  store.started('cmd_running', child);
  assert.ok(store.state('cmd_running').childIdentity);
  const statePath = path.join(root, 'experiment-runs', 'cmd_running.json');
  fs.writeFileSync(statePath, JSON.stringify({ ...store.state('cmd_running'), ownerPid: 999999 }));
  store.requestCancellation('cmd_running');
  const restarted = createOrdinaryExperimentStore(root, options);
  await restarted.recover();
  assert.equal(restarted.state('cmd_running').stage, 'terminal');
  assert.equal(restarted.cancellation('cmd_running').confirmed, true);
  assert.deepEqual(await restarted.reconcile('cmd_running'), { confirmed: true });
});

test('进程身份不符时不会向复用的 PID 发送信号', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-experiment-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signalled: string[] = [];
  const store = createOrdinaryExperimentStore(root, {
    processIdentity: () => 'another process', processGroupAlive: () => true,
    signalGroup: (_pid: number, signal: string) => { signalled.push(signal); },
  });
  store.accept('cmd_reused');
  store.started('cmd_reused', { pid: 54321 });
  const statePath = path.join(root, 'experiment-runs', 'cmd_reused.json');
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.writeFileSync(statePath, JSON.stringify({ ...state, childIdentity: 'original process' }));
  assert.deepEqual(await store.reconcile('cmd_reused'), { confirmed: false, reason: 'RUN_PROCESS_UNCONFIRMED' });
  assert.deepEqual(signalled, []);
});

test('客户端停止指令依据持久化状态返回确认结果', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-experiment-command-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createOrdinaryExperimentStore(path.join(root, 'client'));
  store.accept('cmd_known');
  const script = `const client=require(${JSON.stringify(path.resolve('scripts/reliability-client.cjs'))});
    const statuses=[];
    const send=(status,payload)=>{statuses.push({status,...payload})};
    (async()=>{await client.executeAction({}, {action:'CANCEL_EXPERIMENT_RUN',payload:{kind:'ordinary',runId:'cmd_known'}},send);
    await client.executeAction({}, {action:'CANCEL_EXPERIMENT_RUN',payload:{kind:'ordinary',runId:'cmd_legacy'}},send);
    console.log(JSON.stringify(statuses));})().catch(error=>{console.error(error);process.exitCode=1});`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      env: { ...process.env, AGENT_INSIGHT_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code: number | null) => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  const statuses = JSON.parse(output.trim());
  assert.deepEqual(statuses.map((item: { result: { status: string } }) => item.result.status), ['cancelled', 'cancelling']);
  assert.equal(statuses[1].result.reason, 'RUN_STATE_UNAVAILABLE');
  assert.equal(store.cancellation('cmd_known').confirmed, true);
});

test('客户端重启前先结束正在执行的普通实验并写入终态', { skip: process.platform === 'win32', timeout: 15_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ordinary-experiment-shutdown-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fake-agent'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o700 });
  const runId = 'cmd_shutdown';
  const script = `const client=require(${JSON.stringify(path.resolve('scripts/reliability-client.cjs'))});
    client.executeAction({clientId:'test',workspaceBase:process.cwd()}, {
      action:'RUN_EXPERIMENT_CASE',commandId:${JSON.stringify(runId)},
      payload:{platform:'fake-agent',agent:'build',input:'hello',timeoutSeconds:30}
    }, async()=>{}).catch(error=>{console.error(error);process.exitCode=1});`;
  const child = spawn(process.execPath, ['-e', script], {
    cwd: root, env: { ...process.env, AGENT_INSIGHT_HOME: root, PATH: `${bin}:${process.env.PATH}` },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => {
    try { process.kill(child.pid!, 'SIGKILL'); } catch { /* already stopped */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = createOrdinaryExperimentStore(path.join(root, 'client'));
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
  const deadline = Date.now() + 5000;
  while (store.state(runId)?.stage !== 'running' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(store.state(runId)?.stage, 'running', stderr);
  child.kill('SIGTERM');
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(exitCode, 0, stderr);
  assert.equal(store.state(runId).stage, 'terminal');
  assert.equal(store.state(runId).cleanupConfirmed, true);
});
