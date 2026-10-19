import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('scripts/container-runtime.py');
const probe = `
  const fs = require('node:fs');
  const path = require('node:path');
  const owner = JSON.parse(process.env.AGENT_INSIGHT_RUNTIME_OWNER);
  const held = fs.fstatSync(owner.fd);
  const onDisk = fs.statSync(path.join(owner.scope, '.runtime-owner.lock'));
  process.stdout.write(JSON.stringify({ owner, pid: process.pid, inherited: held.ino === onDisk.ino && held.dev === onDisk.dev }) + '\\n');
  setInterval(() => {}, 1000);
`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'container-runtime-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return home;
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill(signal);
  await exited;
}

async function launch(home: string, t: { after: (fn: () => Promise<void>) => void }) {
  const child = spawn('python3', [script, home, process.execPath, '-e', probe], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AGENT_INSIGHT_RUNTIME_OWNER: '{"id":"untrusted-inherited-value"}' },
  });
  t.after(() => stop(child, 'SIGKILL'));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const line = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`runtime launch timed out: ${stderr}`)), 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`runtime exited before ready (${code ?? signal}): ${stderr}`)); });
    child.stdout.on('data', chunk => {
      stdout += String(chunk);
      if (stdout.includes('\n')) { clearTimeout(timeout); resolve(stdout.split('\n')[0]); }
    });
  });
  const result = JSON.parse(line) as {
    owner: { version: number; id: string; scope: string; fd: number }; pid: number; inherited: boolean;
  };
  return { child, ...result };
}

test('container runtime holds a kernel lock across exec and rejects a concurrent service', async t => {
  if (process.platform === 'win32') return t.skip('container flock requires a Unix host');
  const home = await fixture(t);
  const running = await launch(home, t);
  assert.equal(running.pid, running.child.pid);
  assert.equal(running.inherited, true);
  assert.equal(running.owner.version, 1);
  assert.equal(running.owner.scope, await fs.realpath(home));
  assert.match(running.owner.id, /^[a-f0-9-]{36}$/);
  const lock = path.join(home, '.runtime-owner.lock');
  assert.deepEqual(JSON.parse(await fs.readFile(lock, 'utf8')), {
    version: 1, id: running.owner.id, scope: running.owner.scope,
  });
  const blocked = spawnSync('python3', [script, home, process.execPath, '-e', 'process.stdout.write("unexpected launch")'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(blocked.error, undefined);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /already in use/i);
  assert.equal(blocked.stdout, '');
  assert.equal(JSON.parse(await fs.readFile(lock, 'utf8')).id, running.owner.id);
});

test('container restart gets a fresh runtime after SIGTERM and SIGKILL without replacing the guard file', async t => {
  if (process.platform === 'win32') return t.skip('container flock requires a Unix host');
  const home = await fixture(t);
  let running = await launch(home, t);
  const lock = path.join(home, '.runtime-owner.lock');
  const initial = await fs.stat(lock);
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const oldId = running.owner.id;
    await stop(running.child, signal);
    running = await launch(home, t);
    assert.notEqual(running.owner.id, oldId);
    const current = await fs.stat(lock);
    assert.equal(current.ino, initial.ino);
    assert.equal(current.dev, initial.dev);
  }
});

test('container runtime refuses symlink or non-regular guard paths without modifying their targets', async t => {
  if (process.platform === 'win32') return t.skip('container flock requires a Unix host');
  const root = await fixture(t);
  const victim = path.join(root, 'keep.txt');
  await fs.writeFile(victim, 'business data');
  for (const kind of ['symlink', 'directory', 'hardlink'] as const) {
    const home = path.join(root, kind);
    await fs.mkdir(home);
    const lock = path.join(home, '.runtime-owner.lock');
    if (kind === 'symlink') await fs.symlink(victim, lock);
    else if (kind === 'hardlink') await fs.link(victim, lock);
    else await fs.mkdir(lock);
    const result = spawnSync('python3', [script, home, process.execPath, '-e', 'process.stdout.write("unexpected launch")'], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /runtime lock/i);
  }
  assert.equal(await fs.readFile(victim, 'utf8'), 'business data');
});
