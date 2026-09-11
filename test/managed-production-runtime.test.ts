import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const runtime = require('../scripts/lib/managed-production-runtime.cjs');

async function listen(host = '127.0.0.1', port = 0) {
  const server = net.createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen({host, port, ipv6Only: true}, resolve); });
  return {server, port: (server.address() as net.AddressInfo).port};
}
async function close(server: net.Server) { await new Promise<void>(resolve => server.close(() => resolve())); }
async function fixture() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-runtime-test-'));
  const dataRoot = path.join(project, 'data'); fs.mkdirSync(dataRoot);
  const entry = path.join(project, 'server.cjs');
  fs.writeFileSync(entry, "require('node:http').createServer((req,res)=>res.end(JSON.stringify({pid:process.pid,data:process.env.FIXTURE_DATA}))).listen(Number(process.env.PORT),'127.0.0.1');\n");
  const reserved = await listen(); await close(reserved.server);
  return {project, dataRoot, port: reserved.port, entry, cwd: project, logFile: path.join(dataRoot, 'server.log'), env: {...process.env, PORT: String(reserved.port), FIXTURE_DATA: 'persisted-data', PRIVATE_FIXTURE_KEY: 'must-not-be-written'}, startupTimeoutMs: 5000};
}
async function waitStopped(config: any) {
  const until = Date.now() + 6000;
  while (Date.now() < until) {
    const state = await runtime.inspectManaged(config);
    if (state.status === 'stopped') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('managed service did not stop');
}

test('starts production HTTP service, restarts only its owned process and keeps the data root', async () => {
  const config = await fixture();
  try {
    assert.equal((await runtime.inspectManaged(config)).status, 'stopped');
    const first = await runtime.startManaged(config);
    const response = await fetch(`http://127.0.0.1:${config.port}`).then(r => r.json());
    assert.equal(response.pid, first.serverPid); assert.equal(response.data, 'persisted-data');
    const state = await runtime.inspectManaged(config);
    assert.equal(state.status, 'owned'); assert.equal(state.serverPid, first.serverPid);
    assert.equal(fs.statSync(path.dirname(state.stateFile)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(state.stateFile).mode & 0o777, 0o600);
    assert(!fs.readFileSync(state.stateFile, 'utf8').includes('must-not-be-written'));
    await runtime.assertCanStart(config);
    const second = await runtime.startManaged(config);
    assert.notEqual(second.serverPid, first.serverPid);
    assert.equal((await fetch(`http://127.0.0.1:${config.port}`).then(r => r.json())).data, 'persisted-data');
    assert.throws(() => process.kill(first.serverPid, 0));
    await runtime.stopManaged(config); await waitStopped(config);
    assert.throws(() => process.kill(second.serverPid, 0));
  } finally { await runtime.stopManaged(config); fs.rmSync(config.project, {recursive: true, force: true}); }
});

test('unrelated IPv4 listener is rejected and never terminated', async () => {
  const config = await fixture(); const foreign = await listen('127.0.0.1', config.port);
  try {
    assert.equal((await runtime.inspectManaged(config)).status, 'foreign');
    await assert.rejects(runtime.assertCanStart(config), /占用|occupied/);
    await assert.rejects(runtime.startManaged(config), /占用|occupied/);
    await assert.rejects(runtime.stopManaged(config), /占用|归属|owned|ownership|occupied/);
    assert(foreign.server.listening);
  } finally { await close(foreign.server); fs.rmSync(config.project, {recursive: true, force: true}); }
});

test('an IPv6-only listener also prevents a conflicting startup', async t => {
  const config = await fixture(); let foreign;
  try { foreign = await listen('::1', config.port); }
  catch (error: any) { fs.rmSync(config.project, {recursive: true, force: true}); if (['EAFNOSUPPORT','EADDRNOTAVAIL'].includes(error.code)) return t.skip('IPv6 unavailable'); throw error; }
  try {
    await assert.rejects(runtime.assertCanStart(config), /占用|occupied/);
    assert(foreign.server.listening);
  } finally { await close(foreign.server); fs.rmSync(config.project, {recursive: true, force: true}); }
});

test('wrong token cannot stop an owned server and a stale PID never grants ownership', async () => {
  const config = await fixture(); let saved: string | undefined; let stateFile: string | undefined;
  try {
    const running = await runtime.startManaged(config); stateFile = running.stateFile;
    saved = fs.readFileSync(stateFile!, 'utf8');
    fs.writeFileSync(stateFile!, JSON.stringify({...JSON.parse(saved), token: 'incorrect', pid: process.pid}), {mode: 0o600});
    await assert.rejects(runtime.stopManaged(config), /占用|归属|owned|ownership|occupied/);
    assert.equal((await fetch(`http://127.0.0.1:${config.port}`).then(r => r.json())).pid, running.serverPid);
    fs.writeFileSync(stateFile!, saved); await runtime.stopManaged(config); await waitStopped(config);
    fs.writeFileSync(stateFile!, saved);
    assert.equal((await runtime.inspectManaged(config)).status, 'stopped');
    const restarted = await runtime.startManaged(config);
    assert.notEqual(restarted.serverPid, running.serverPid);
  } finally {
    if (saved && stateFile && fs.existsSync(stateFile)) {
      const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (current.token === 'incorrect') fs.writeFileSync(stateFile, saved);
    }
    await runtime.stopManaged(config); fs.rmSync(config.project, {recursive: true, force: true});
  }
});

test('failed startup cleans its state and does not leave a server process', async () => {
  const config = await fixture();
  fs.writeFileSync(config.entry, "require('node:fs').writeFileSync('failed-pid',String(process.pid));process.exit(9);\n");
  try {
    await assert.rejects(runtime.startManaged(config), /启动|退出|start|exit/);
    await waitStopped(config);
    const state = await runtime.inspectManaged(config);
    assert(!fs.existsSync(state.stateFile));
    const failedPid = Number(fs.readFileSync(path.join(config.project, 'failed-pid'), 'utf8'));
    assert.throws(() => process.kill(failedPid, 0));
    await runtime.assertCanStart(config);
  } finally { await runtime.stopManaged(config); fs.rmSync(config.project, {recursive: true, force: true}); }
});

test('SIGTERM to the manager also stops its child and clears ownership state', async () => {
  const config = await fixture();
  try {
    const running = await runtime.startManaged(config);
    process.kill(running.pid, 'SIGTERM'); await waitStopped(config);
    assert.throws(() => process.kill(running.serverPid, 0));
  } finally { await runtime.stopManaged(config); fs.rmSync(config.project, {recursive: true, force: true}); }
});

test('another data directory cannot take ownership of the same running port', async () => {
  const config = await fixture();
  const otherRoot = path.join(config.project, 'other-data'); fs.mkdirSync(otherRoot);
  try {
    const running = await runtime.startManaged(config);
    await assert.rejects(runtime.startManaged({...config, dataRoot: otherRoot}), /占用|occupied/);
    assert.equal((await fetch(`http://127.0.0.1:${config.port}`).then(r => r.json())).pid, running.serverPid);
  } finally { await runtime.stopManaged(config); fs.rmSync(config.project, {recursive: true, force: true}); }
});

test('invalid spawn cwd and startup timeout clean up without leaving a child', async () => {
  const config = await fixture();
  try {
    const startedAt = Date.now();
    await assert.rejects(runtime.startManaged({...config, cwd: path.join(config.project, 'missing'), startupTimeoutMs: 200}), /启动|退出|start|exit/);
    assert(Date.now() - startedAt < 3000, 'spawn error should be reported immediately');
    fs.writeFileSync(config.entry, "require('node:fs').writeFileSync('hung-pid',String(process.pid));setInterval(()=>{},1000);\n");
    await assert.rejects(runtime.startManaged({...config, startupTimeoutMs: 200}), /启动|退出|start|exit/);
    await waitStopped(config);
    const hungPid = Number(fs.readFileSync(path.join(config.project, 'hung-pid'), 'utf8'));
    assert.throws(() => process.kill(hungPid, 0));
  } finally { await runtime.stopManaged(config); fs.rmSync(config.project, {recursive: true, force: true}); }
});

test('malformed multibyte authentication token leaves the manager and child alive', async () => {
  const config = await fixture(); let saved: string | undefined; let stateFile: string | undefined;
  try {
    const running = await runtime.startManaged(config); stateFile = running.stateFile;
    saved = fs.readFileSync(stateFile!, 'utf8');
    fs.writeFileSync(stateFile!, JSON.stringify({...JSON.parse(saved), token: '错'.repeat(64)}));
    await assert.rejects(runtime.stopManaged(config), /占用|归属|owned|ownership|occupied/);
    fs.writeFileSync(stateFile!, saved);
    assert.equal((await runtime.inspectManaged(config)).status, 'owned');
    assert.equal((await fetch(`http://127.0.0.1:${config.port}`).then(r => r.json())).pid, running.serverPid);
  } finally {
    if (saved && stateFile) fs.writeFileSync(stateFile, saved);
    await runtime.stopManaged(config); fs.rmSync(config.project, {recursive: true, force: true});
  }
});

test('a process that opens the port without serving HTTP is not reported ready', async () => {
  const config = await fixture();
  fs.writeFileSync(config.entry, "require('node:fs').writeFileSync('no-http-pid',String(process.pid));require('node:net').createServer(socket=>socket.end('not-http')).listen(Number(process.env.PORT),'127.0.0.1');\n");
  try {
    await assert.rejects(runtime.startManaged({...config, startupTimeoutMs: 250}), /启动|退出|start|exit/);
    await waitStopped(config);
    const pid = Number(fs.readFileSync(path.join(config.project, 'no-http-pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0));
  } finally { await runtime.stopManaged(config); fs.rmSync(config.project, {recursive: true, force: true}); }
});
