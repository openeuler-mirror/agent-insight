import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireSpoolUse, markSpoolPurged, noteSpoolReceived, readSpoolState, readSpoolStateBySegment, recordSpoolPersistence, safeSpoolSegment, trySpoolMaintenance } from '../src/lib/runtime-cleanup/spool-state';

function fixture(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-state-test-'));
  try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('only matching explicit completed receipt succeeds and retries never renew last receipt', () => fixture(root => {
  const a = noteSpoolReceived(root, 'session', 100);
  recordSpoolPersistence(root, 'session', a, {});
  assert.notEqual(readSpoolState(root, 'session')?.status, 'success');
  const b = noteSpoolReceived(root, 'session', 200);
  recordSpoolPersistence(root, 'session', a, { completedAt: 201 });
  assert.equal(readSpoolState(root, 'session')?.generation, b);
  assert.notEqual(readSpoolState(root, 'session')?.status, 'success');
  recordSpoolPersistence(root, 'session', b, { completedAt: 201, taskId: 'trace-1' });
  assert.equal(readSpoolState(root, 'session')?.status, 'success');
  recordSpoolPersistence(root, 'session', b, { failed: true });
  assert.equal(readSpoolState(root, 'session')?.lastReceivedAt, 200);
  assert.equal(readSpoolState(root, 'session')?.status, 'failed');
}));

test('purged marker survives future receipt and hostile keys remain inside state directory', () => fixture(root => {
  const key = '../../outside/name';
  noteSpoolReceived(root, key, 100);
  trySpoolMaintenance(root, () => markSpoolPurged(root, key, 200));
  const current = noteSpoolReceived(root, key, 300);
  const state = readSpoolStateBySegment(root, safeSpoolSegment(key));
  assert.equal(state?.purgedAt, 200);
  assert.equal(state?.generation, current);
  assert.equal(state?.lastReceivedAt, 300);
  assert.equal(readSpoolStateBySegment(root, '../outside'), undefined);
}));

test('leases exclude maintenance, maintenance excludes producers, and callback exceptions release ownership', () => fixture(root => {
  const release = acquireSpoolUse(root);
  assert.ok(release);
  assert.equal(trySpoolMaintenance(root, () => 'bad'), undefined);
  release();
  assert.throws(() => trySpoolMaintenance(root, () => {
    assert.equal(acquireSpoolUse(root), null);
    throw new Error('expected');
  }), /expected/);
  assert.equal(trySpoolMaintenance(root, () => 'ok'), 'ok');
}));

test('more than 32 leases conservatively skips maintenance without blocking producers', () => fixture(root => {
  const releases = Array.from({ length: 34 }, () => acquireSpoolUse(root));
  assert.ok(releases.every(Boolean));
  assert.equal(trySpoolMaintenance(root, () => 'bad'), undefined);
  for (const release of releases) release?.();
  assert.equal(trySpoolMaintenance(root, () => 'ok'), 'ok');
}));

test('malformed and oversized state and symbolic metadata directories fail safe', () => fixture(root => {
  noteSpoolReceived(root, 'session', 100);
  const stateFile = path.join(root, '.retention-v1', 'states', `${createHash('sha256').update('session').digest('hex')}.json`);
  fs.writeFileSync(stateFile, '{"broken":true}');
  assert.ok(Number.isNaN(readSpoolState(root, 'session')?.lastReceivedAt));
  fs.writeFileSync(stateFile, ' '.repeat(17 * 1024));
  assert.ok(Number.isNaN(readSpoolState(root, 'session')?.lastReceivedAt));
  const alias = path.join(root, 'alias');
  fs.symlinkSync(path.join(root, '.retention-v1'), alias);
  fs.renameSync(path.join(root, '.retention-v1'), path.join(root, 'real'));
  fs.symlinkSync(path.join(root, 'real'), path.join(root, '.retention-v1'));
  assert.equal(acquireSpoolUse(root), null);
  assert.equal(trySpoolMaintenance(root, () => 'bad'), undefined);
}));

test('foreign and malformed owners protect leases while same-host dead owners are reclaimed', () => fixture(root => {
  const release = acquireSpoolUse(root)!;
  release();
  const uses = path.join(root, '.retention-v1', 'uses');
  fs.writeFileSync(path.join(uses, 'foreign.json'), JSON.stringify({ host: 'foreign-host', pid: 2147483647, token: 'foreign' }));
  assert.equal(trySpoolMaintenance(root, () => 'bad'), undefined);
  fs.unlinkSync(path.join(uses, 'foreign.json'));
  fs.writeFileSync(path.join(uses, 'malformed.json'), '{}');
  assert.equal(trySpoolMaintenance(root, () => 'bad'), undefined);
  fs.unlinkSync(path.join(uses, 'malformed.json'));
  fs.writeFileSync(path.join(uses, 'dead.json'), JSON.stringify({ host: os.hostname(), pid: 2147483647, token: 'dead' }));
  assert.equal(trySpoolMaintenance(root, () => 'ok'), 'ok');
  assert.equal(fs.existsSync(path.join(uses, 'dead.json')), false);
}));

test('receipt attempts fail closed during maintenance and preserve the prior generation', () => fixture(root => {
  const generation = noteSpoolReceived(root, 'session', 100);
  trySpoolMaintenance(root, () => {
    assert.throws(() => noteSpoolReceived(root, 'session', 200), /maintenance/);
  });
  assert.equal(readSpoolState(root, 'session')?.generation, generation);
}));

test('stale canonical lock reclamation excludes another cleaner until fresh ownership is published', () => fixture(root => {
  acquireSpoolUse(root)!();
  const lock = path.join(root, '.retention-v1', 'maintenance.lock');
  fs.writeFileSync(lock, JSON.stringify({ host: os.hostname(), pid: 2147483647, token: 'dead' }));
  const originalUnlink = fs.unlinkSync;
  let nested: string | undefined;
  let intercepted = false;
  fs.unlinkSync = ((file: fs.PathLike) => {
    if (file === lock && !intercepted) {
      intercepted = true;
      nested = trySpoolMaintenance(root, () => 'competing-owner');
    }
    return originalUnlink(file);
  }) as typeof fs.unlinkSync;
  let result: string | undefined;
  try { result = trySpoolMaintenance(root, () => 'owner'); }
  finally { fs.unlinkSync = originalUnlink; }
  assert.ok(intercepted);
  assert.equal(nested, undefined);
  assert.equal(result, 'owner');
}));

test('pending purge intent suppresses tombstone until raw removal and survives a fresh receipt', () => fixture(root => {
  const file = path.join(root, 'raw.jsonl');
  fs.writeFileSync(file, 'raw');
  const info = fs.statSync(file);
  noteSpoolReceived(root, 'session', 100);
  trySpoolMaintenance(root, () => markSpoolPurged(root, 'session', 200, { path: file, ino: info.ino, dev: info.dev }));
  assert.equal(readSpoolState(root, 'session')?.purgedAt, undefined);
  noteSpoolReceived(root, 'session', 300);
  assert.equal(readSpoolState(root, 'session')?.purgedAt, undefined);
  fs.unlinkSync(file);
  assert.equal(readSpoolState(root, 'session')?.purgedAt, 200);
  fs.writeFileSync(file, 'later raw');
  const later = fs.statSync(file);
  trySpoolMaintenance(root, () => markSpoolPurged(root, 'session', 400, { path: file, ino: later.ino, dev: later.dev }));
  assert.equal(readSpoolState(root, 'session')?.purgedAt, 200);
}));

test('a reused inode cannot make a previously deleted cache appear intact', () => fixture(root => {
  const file = path.join(root, 'raw.jsonl');
  fs.writeFileSync(file, 'late fragment');
  const info = fs.statSync(file);
  noteSpoolReceived(root, 'session', 100);
  trySpoolMaintenance(root, () => markSpoolPurged(root, 'session', 200, {
    path: file, ino: info.ino, dev: info.dev, birthtimeMs: info.birthtimeMs - 1, ctimeMs: info.ctimeMs - 1,
  }));
  assert.equal(readSpoolState(root, 'session')?.purgedAt, 200);
}));
