import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DAY_MS } from '@/lib/runtime-cleanup/policy';
import { cleanupSpool } from '@/lib/runtime-cleanup/spool';
import { acquireSpoolUse, noteSpoolReceived, recordSpoolPersistence, readSpoolState, trySpoolMaintenance } from '@/lib/runtime-cleanup/spool-state';

const now = Date.UTC(2026, 8, 30);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-cleanup-spool-'));
  const file = (id: string, age: number, content = JSON.stringify({ sessionId: id }) + '\n') => {
    const p = path.join(root, '2026-09-01', 'sessions', id, 'logs.jsonl');
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content);
    const date = new Date(now - age * DAY_MS); fs.utimesSync(p, date, date);
    return p;
  };
  return { root, file, dispose: () => fs.rmSync(root, { recursive: true, force: true }) };
}
async function collect(iterator: AsyncGenerator<any>) { const events = []; for await (const e of iterator) events.push(e); return events; }

test('normal cache is deleted after 7d; receipts do not remove business records', async () => {
  const f = fixture();
  try {
    const p = f.file('done', 8);
    const generation = noteSpoolReceived(f.root, 'done', now - 8 * DAY_MS);
    recordSpoolPersistence(f.root, 'done', generation, { completedAt: now - 8 * DAY_MS, failed: false });
    const business = path.join(f.root, 'business.db'); fs.writeFileSync(business, 'preserve');
    const events = await collect(cleanupSpool({ root: f.root, now }));
    assert.equal(fs.existsSync(p), false);
    assert.equal(fs.readFileSync(business, 'utf8'), 'preserve');
    assert.ok(readSpoolState(f.root, 'done')?.purgedAt);
    assert.ok(events.some(e => e.kind === 'deleted' && e.bytes > 0));
  } finally { f.dispose(); }
});

test('failed, unparsed and abandoned cache expires after 14d and retries do not renew it', async () => {
  const f = fixture();
  try {
    const old = f.file('failed', 15);
    const keep = f.file('recent', 10);
    const generation = noteSpoolReceived(f.root, 'failed', now - 15 * DAY_MS);
    recordSpoolPersistence(f.root, 'failed', generation, { failed: true });
    recordSpoolPersistence(f.root, 'failed', generation, { failed: true });
    await collect(cleanupSpool({ root: f.root, now }));
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(keep), true);
  } finally { f.dispose(); }
});

test('new activity, in-flight work and append during paused cleanup protect files', async () => {
  const f = fixture();
  try {
    const p = f.file('running', 20);
    noteSpoolReceived(f.root, 'running', now - DAY_MS);
    await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(p));
    noteSpoolReceived(f.root, 'running', now - 20 * DAY_MS);
    const release = acquireSpoolUse(f.root)!;
    await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(p));
    release();
    const iterator = cleanupSpool({ root: f.root, now });
    await iterator.next();
    noteSpoolReceived(f.root, 'running', now);
    await collect(iterator);
    assert.ok(fs.existsSync(p));
  } finally { f.dispose(); }
});

test('stale persistence result cannot confirm a newer receive generation', () => {
  const f = fixture();
  try {
    const old = noteSpoolReceived(f.root, 'same', now - 9 * DAY_MS);
    const current = noteSpoolReceived(f.root, 'same', now);
    recordSpoolPersistence(f.root, 'same', old, { completedAt: now - 9 * DAY_MS });
    assert.equal(readSpoolState(f.root, 'same')?.generation, current);
    assert.notEqual(readSpoolState(f.root, 'same')?.status, 'success');
  } finally { f.dispose(); }
});

test('failed raw unlink does not activate a purge marker; a later successful retry does', async () => {
  const f = fixture();
  const unlink = fs.unlinkSync;
  try {
    const p = f.file('unlink-retry', 8);
    const canonicalFile = fs.realpathSync(p);
    const generation = noteSpoolReceived(f.root, 'unlink-retry', now - 8 * DAY_MS);
    recordSpoolPersistence(f.root, 'unlink-retry', generation, { completedAt: now - 8 * DAY_MS });
    fs.unlinkSync = ((file: fs.PathLike) => {
      if (String(file) === canonicalFile) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
      unlink(file);
    }) as typeof fs.unlinkSync;
    await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(p));
    assert.equal(readSpoolState(f.root, 'unlink-retry')?.purgedAt, undefined);
    fs.unlinkSync = unlink;
    await collect(cleanupSpool({ root: f.root, now }));
    assert.equal(fs.existsSync(p), false);
    assert.equal(readSpoolState(f.root, 'unlink-retry')?.purgedAt, now);
  } finally { fs.unlinkSync = unlink; f.dispose(); }
});

test('maintenance and producers exclude each other without waiting', () => {
  const f = fixture();
  try {
    const release = acquireSpoolUse(f.root)!;
    assert.equal(trySpoolMaintenance(f.root, () => 'deleted'), undefined);
    release();
    assert.equal(trySpoolMaintenance(f.root, () => {
      assert.equal(acquireSpoolUse(f.root), null); return 'ok';
    }), 'ok');
  } finally { f.dispose(); }
});

test('legacy processed files, mixed sessions, dry-run and symlinks are bounded and safe', async () => {
  const f = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-cleanup-outside-'));
  try {
    const p = f.file('archive', 20) + '.processed';
    fs.renameSync(p.replace('.processed', ''), p);
    const legacy = path.join(f.root, '2026-09-01', 'logs.jsonl');
    fs.writeFileSync(legacy, '{"sessionId":"old"}\n{"sessionId":"active"}\n');
    fs.utimesSync(legacy, new Date(now - 20 * DAY_MS), new Date(now - 20 * DAY_MS));
    noteSpoolReceived(f.root, 'active', now);
    fs.writeFileSync(path.join(outside, 'logs.jsonl'), 'preserve');
    fs.symlinkSync(outside, path.join(f.root, '2026-09-02'));
    await collect(cleanupSpool({ root: f.root, now, dryRun: true }));
    assert.ok(fs.existsSync(p));
    assert.equal(fs.existsSync(path.join(f.root, '.retention-v1', 'maintenance.lock')), false);
    await collect(cleanupSpool({ root: f.root, now }));
    assert.equal(fs.existsSync(p), false);
    assert.ok(fs.existsSync(legacy));
    assert.equal(fs.readFileSync(path.join(outside, 'logs.jsonl'), 'utf8'), 'preserve');
  } finally { f.dispose(); fs.rmSync(outside, { recursive: true, force: true }); }
});

function bucketFile(root: string, id: string, age: number, rows: unknown[]) {
  const file = path.join(root, 'buckets', `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  fs.utimesSync(file, new Date(now - age * DAY_MS), new Date(now - age * DAY_MS));
  return file;
}
function complete(root: string, key: string, age: number, taskId?: string) {
  const generation = noteSpoolReceived(root, key, now - age * DAY_MS);
  recordSpoolPersistence(root, key, generation, { completedAt: now - age * DAY_MS, taskId });
}

test('Jiuwen completed group cache expires at 7d and active group protects old member buckets', async () => {
  const f = fixture();
  try {
    const done = bucketFile(f.root, 'done-member', 8, [{ traceId: 'done-member', name: 'team.run', attrs: { 'agentteam.session.id': 'done-group' } }]);
    complete(f.root, 'done-member', 8, 'jiuwen-session-done-group');
    complete(f.root, 'session:done-group', 8, 'jiuwen-session-done-group');
    const active = bucketFile(f.root, 'active-member', 20, [{ traceId: 'active-member', name: 'team.run', attrs: { 'agentteam.session.id': 'active-group' } }]);
    complete(f.root, 'active-member', 20, 'jiuwen-session-active-group');
    noteSpoolReceived(f.root, 'session:active-group', now - DAY_MS);
    await collect(cleanupSpool({ root: f.root, now }));
    assert.equal(fs.existsSync(done), false);
    assert.equal(fs.existsSync(active), true);
  } finally { f.dispose(); }
});

test('single Jiuwen ACP traces ignore unrelated activity in a shared session', async () => {
  const f = fixture();
  try {
    const file = bucketFile(f.root, 'acp-one', 8, [{ traceId: 'acp-one', name: 'invoke_agent', attrs: { 'agentteam.session.id': 'shared' } }]);
    complete(f.root, 'acp-one', 8, 'jiuwen-acp-one');
    noteSpoolReceived(f.root, 'session:shared', now);
    await collect(cleanupSpool({ root: f.root, now }));
    assert.equal(fs.existsSync(file), false);
  } finally { f.dispose(); }
});

test('unmarked Jiuwen grouped receipts retain shared-session activity protection', async () => {
  const f = fixture();
  try {
    const file = bucketFile(f.root, 'child', 20, [{ traceId: 'child', name: 'invoke_agent', attrs: { 'agentteam.session.id': 'group' } }]);
    complete(f.root, 'child', 20, 'jiuwen-session-group');
    noteSpoolReceived(f.root, 'session:group', now);
    await collect(cleanupSpool({ root: f.root, now }));
    assert.equal(fs.existsSync(file), true);
  } finally { f.dispose(); }
});

test('oversized legacy lines and too many owners are skipped with bounded reads', async () => {
  const f = fixture();
  try {
    const directory = path.join(f.root, '2026-09-01'); fs.mkdirSync(directory, { recursive: true });
    const huge = path.join(directory, 'logs.jsonl');
    fs.writeFileSync(huge, JSON.stringify({ sessionId: 'old', padding: 'x'.repeat(1024 * 1024) }) + '\n');
    const many = path.join(directory, 'traces.jsonl');
    fs.writeFileSync(many, Array.from({ length: 17 }, (_, i) => JSON.stringify({ sessionId: `session-${i}` })).join('\n') + '\n');
    for (const file of [huge, many]) fs.utimesSync(file, new Date(now - 20 * DAY_MS), new Date(now - 20 * DAY_MS));
    const events = await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(huge) && fs.existsSync(many));
    assert.ok(events.reduce((total, event) => total + (event.scannedBytes || 0), 0) < 512 * 1024);
    assert.equal(events.filter(event => event.reason === 'legacy-ownership-unknown').length, 2);
  } finally { f.dispose(); }
});

function datedFile(root: string, age: number, name: string, sessionId?: string) {
  const date = new Date(now - age * DAY_MS);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const directory = sessionId ? path.join(root, day, 'sessions', sessionId) : path.join(root, day);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, JSON.stringify({ sessionId: sessionId || 'same' }) + '\n');
  fs.utimesSync(file, date, date);
  return file;
}

test('legacy modern-partition cache remains protected by activity in another modern day', async () => {
  const f = fixture();
  try {
    const old = datedFile(f.root, 20, 'logs.jsonl', 'same');
    datedFile(f.root, 1, 'logs.jsonl', 'same');
    await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(old));
  } finally { f.dispose(); }
});

test('legacy flat cache remains protected by new activity in a modern day', async () => {
  const f = fixture();
  try {
    const old = datedFile(f.root, 20, 'logs.jsonl');
    datedFile(f.root, 1, 'logs.jsonl', 'same');
    await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(old));
  } finally { f.dispose(); }
});

test('old modern cache remains protected by recent legacy flat data for the same session', async () => {
  const f = fixture();
  try {
    const old = datedFile(f.root, 20, 'logs.jsonl', 'same');
    datedFile(f.root, 1, 'logs.jsonl');
    await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(old));
  } finally { f.dispose(); }
});

test('corrupt persisted state protects raw data rather than falling back to expired file age', async () => {
  const f = fixture();
  try {
    const file = f.file('corrupt', 20);
    complete(f.root, 'corrupt', 20);
    const states = path.join(f.root, '.retention-v1', 'states');
    const stateFile = fs.readdirSync(states).find(name => name.endsWith('.json'))!;
    fs.writeFileSync(path.join(states, stateFile), '{"status":"success"}');
    await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(file));
  } finally { f.dispose(); }
});

test('candidate changed after eligibility yield is preserved', async () => {
  const f = fixture();
  try {
    const file = f.file('changed', 20);
    complete(f.root, 'changed', 20);
    const iterator = cleanupSpool({ root: f.root, now });
    let changed = false;
    for await (const event of iterator) {
      if (event.kind === 'scanned' && event.scannedBytes === 32 * 1024 && !changed && fs.existsSync(file)) {
        fs.appendFileSync(file, '{"sessionId":"changed","new":true}\n'); changed = true;
      }
    }
    assert.ok(fs.existsSync(file));
  } finally { f.dispose(); }
});


test('file symlink substituted at the deletion boundary cannot remove its target', async () => {
  const f = fixture();
  try {
    const file = f.file('swapped-file', 20);
    complete(f.root, 'swapped-file', 20);
    const outside = path.join(f.root, 'unrelated-business-file');
    fs.writeFileSync(outside, 'business');
    let swapped = false;
    for await (const event of cleanupSpool({ root: f.root, now })) {
      if (!swapped && event.scannedBytes === 32 * 1024) {
        fs.renameSync(file, path.join(f.root, 'saved-raw'));
        fs.symlinkSync(outside, file);
        swapped = true;
      }
    }
    assert.ok(swapped);
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.equal(fs.readFileSync(outside, 'utf8'), 'business');
  } finally { f.dispose(); }
});

test('session directory swapped to a symlink at deletion boundary preserves external data', async () => {
  const f = fixture();
  try {
    const file = f.file('swapped-directory', 20);
    complete(f.root, 'swapped-directory', 20);
    const outside = path.join(f.root, 'unrelated-directory');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'logs.jsonl'), 'business');
    let swapped = false;
    for await (const event of cleanupSpool({ root: f.root, now })) {
      if (!swapped && event.scannedBytes === 32 * 1024) {
        fs.renameSync(path.dirname(file), path.join(f.root, 'saved-directory'));
        fs.symlinkSync(outside, path.dirname(file));
        swapped = true;
      }
    }
    assert.ok(swapped);
    assert.equal(fs.readFileSync(path.join(outside, 'logs.jsonl'), 'utf8'), 'business');
  } finally { f.dispose(); }
});

test('a legacy line exceeding 256KiB remains protected even when its newline arrives in the current chunk', async () => {
  const f = fixture();
  try {
    const directory = path.join(f.root, '2026-09-01');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'logs.jsonl');
    fs.writeFileSync(file, JSON.stringify({ sessionId: 'too-large', padding: 'x'.repeat(270 * 1024) }) + '\n');
    fs.utimesSync(file, new Date(now - 20 * DAY_MS), new Date(now - 20 * DAY_MS));
    const events = await collect(cleanupSpool({ root: f.root, now }));
    assert.ok(fs.existsSync(file));
    assert.ok(events.some(event => event.reason === 'legacy-ownership-unknown'));
  } finally { f.dispose(); }
});
