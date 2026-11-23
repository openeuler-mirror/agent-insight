/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { acquireSpoolUse, noteSpoolReceived, readSpoolState, recordSpoolPersistence, trySpoolMaintenance } from '../src/lib/runtime-cleanup/spool-state';
import { acquireConsumerProcessLocks } from '../src/lib/ingest/otel-consumer/process-lock';
import { cleanupLogs } from '../src/lib/runtime-cleanup/logs';
import { cleanupTemporaryHomes, markTemporaryHome, TEMPORARY_HOME_OWNER_FILE } from '../src/lib/runtime-cleanup/temp';
import { runtimeOwner } from '../src/lib/runtime-cleanup/ownership';

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const item of items) values.push(item);
  return values;
}

async function fixture(run: (home: string, restart: () => void) => Promise<void>) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-container-')));
  const before = process.env.AGENT_INSIGHT_RUNTIME_OWNER;
  const fd = fs.openSync(path.join(home, '.runtime-owner.lock'), 'w+');
  const restart = () => {
    const owner = { version: 1, id: randomUUID(), scope: home };
    fs.ftruncateSync(fd);
    fs.writeSync(fd, JSON.stringify(owner), 0, 'utf8');
    process.env.AGENT_INSIGHT_RUNTIME_OWNER = JSON.stringify({ ...owner, fd });
  };
  try { restart(); await run(home, restart); }
  finally {
    if (before === undefined) delete process.env.AGENT_INSIGHT_RUNTIME_OWNER;
    else process.env.AGENT_INSIGHT_RUNTIME_OWNER = before;
    fs.closeSync(fd);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('a restarted container ignores old spool locks while preserving persisted session state', () => fixture(async (home, restart) => {
  const root = path.join(home, 'spool'); fs.mkdirSync(root);
  const generation = noteSpoolReceived(root, 'session', 100);
  recordSpoolPersistence(root, 'session', generation, { completedAt: 101 });
  const use = acquireSpoolUse(root)!;
  const oldConsumer = acquireConsumerProcessLocks([root]); assert.ok(oldConsumer);
  assert.equal(trySpoolMaintenance(root, () => 'unsafe'), undefined);
  restart();
  assert.equal(trySpoolMaintenance(root, () => 'recovered'), 'recovered');
  const currentConsumer = acquireConsumerProcessLocks([root]); assert.ok(currentConsumer);
  assert.equal(acquireConsumerProcessLocks([root]), null);
  assert.equal(readSpoolState(root, 'session')?.status, 'success');
  use(); oldConsumer.release(); currentConsumer.release();
}));

test('legacy foreign maintenance, reaping and consumer locks cannot block a single-container upgrade', () => fixture(async home => {
  const root = path.join(home, 'spool'); fs.mkdirSync(root);
  const metadata = path.join(root, '.retention-v1'); fs.mkdirSync(metadata);
  const owner = JSON.stringify({ host: 'previous-container', pid: process.pid, token: 'legacy' });
  for (const file of ['maintenance.lock', 'maintenance.lock.reaping']) fs.writeFileSync(path.join(metadata, file), owner);
  fs.writeFileSync(path.join(root, 'consumer-owner.lock'), owner);
  const release = acquireSpoolUse(root); assert.ok(release); release();
  assert.equal(trySpoolMaintenance(root, () => 'recovered'), 'recovered');
  const consumer = acquireConsumerProcessLocks([root]); assert.ok(consumer); consumer.release();
}));

test('log rotation recovers across container generations but still excludes a current cleaner', () => fixture(async (home, restart) => {
  const logs = path.join(home, 'logs'); fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'agent-insight.log'), 'payload');
  const legacy = JSON.stringify({ host: 'old-container', pid: process.pid, token: 'legacy' });
  fs.writeFileSync(path.join(logs, '.agent-insight-log-cleanup.reaping'), legacy);
  const old = cleanupLogs({ directory: logs, maxFileBytes: 1 });
  await old.next();
  restart();
  const current = cleanupLogs({ directory: logs, maxFileBytes: 1 });
  await current.next();
  const blocked = await collect(cleanupLogs({ directory: logs, maxFileBytes: 1 }));
  assert.equal(blocked.some(event => event.kind === 'rotated'), false);
  const events = await collect(current);
  assert.equal(events.some(event => event.kind === 'rotated'), true);
  await old.return(undefined);
}));

test('expired previous-container temporary homes are removed while current owners remain protected', () => fixture(async (home, restart) => {
  const root = path.join(home, 'temp');
  const old = path.join(root, 'user', 'isolated-home-old');
  fs.mkdirSync(old, { recursive: true });
  await markTemporaryHome(old, process.pid);
  const owner = JSON.parse(fs.readFileSync(path.join(old, TEMPORARY_HOME_OWNER_FILE), 'utf8'));
  owner.createdAt = Date.now() - 3 * 86_400_000;
  fs.writeFileSync(path.join(old, TEMPORARY_HOME_OWNER_FILE), JSON.stringify(owner));
  await collect(cleanupTemporaryHomes({ root })); assert.ok(fs.existsSync(old));
  restart();
  await collect(cleanupTemporaryHomes({ root })); assert.equal(fs.existsSync(old), false);
}));

test('ownership of HOME does not authorize recovery in an external or symlinked directory', () => fixture(async home => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-external-'));
  try {
    const alias = path.join(home, 'outside'); fs.symlinkSync(outside, alias);
    for (const root of [outside, alias]) {
      acquireSpoolUse(root)?.();
      const base = path.join(outside, '.retention-v1'); fs.mkdirSync(base, { recursive: true });
      fs.writeFileSync(path.join(base, 'maintenance.lock'), JSON.stringify({ host: 'foreign', pid: process.pid, token: 'active' }));
      assert.equal(acquireSpoolUse(root), null);
    }
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test('the real entrypoint wrapper passes ownership through exec into the cleanup module', () => fixture(async home => {
  const module = path.resolve('src/lib/runtime-cleanup/ownership.ts');
  const script = `const { runtimeOwner, runtimeLockDirectory } = require(${JSON.stringify(module)}); const owner = runtimeOwner(process.argv[1]); if (!owner) process.exit(2); console.log(JSON.stringify({id:owner.id, directory:runtimeLockDirectory(process.argv[1])}));`;
  const child = spawnSync('python3', ['scripts/container-runtime.py', home, process.execPath, '--import', 'tsx', '-e', script, home], {
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.directory, path.join(home, '.runtime-owners', result.id));
  assert.equal(runtimeOwner(home), undefined, 'a replaced descriptor record cannot authorize the old process');
}));

test('single-container migration reclaims legacy expired homes but keeps unregistered directories', () => fixture(async home => {
  const root = path.join(home, 'temp');
  const old = path.join(root, 'user', 'isolated-home-old');
  const unknown = path.join(root, 'user', 'isolated-home-unknown');
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(old, TEMPORARY_HOME_OWNER_FILE), JSON.stringify({
    version: 1, hostname: 'previous-container', ownerPid: process.pid, processGroupId: null,
    createdAt: Date.now() - 3 * 86_400_000,
  }));
  await collect(cleanupTemporaryHomes({ root }));
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(unknown), true);
}));

test('a spool under an internal HOME alias uses the same protected runtime directory', () => fixture(async home => {
  const data = path.join(home, 'data'); fs.mkdirSync(data);
  const root = path.join(data, 'spool'); fs.mkdirSync(root);
  const alias = path.join(home, 'alias'); fs.symlinkSync(data, alias);
  const use = acquireSpoolUse(path.join(alias, 'spool')); assert.ok(use);
  assert.equal(trySpoolMaintenance(root, () => 'unsafe'), undefined);
  use();
  assert.equal(trySpoolMaintenance(root, () => 'ok'), 'ok');
}));
