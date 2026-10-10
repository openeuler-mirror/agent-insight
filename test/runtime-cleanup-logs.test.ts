import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { cleanupLogs } from '../src/lib/runtime-cleanup/logs';

const now = Date.UTC(2026, 8, 30, 12);
const day = 86_400_000;
async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'cleanup-logs-test-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function collect(directory: string, options = {}) {
  const events = [];
  for await (const event of cleanupLogs({ directory, now, ...options })) events.push(event);
  return events;
}
const historical = (stamp: number, suffix = 'gz') => `agent-insight.log.${stamp}.00000000-0000-4000-8000-000000000001.${suffix}`;

test('rotates an oversized active log without deleting its contents or unrelated files', async () => fixture(async directory => {
  await writeFile(join(directory, 'agent-insight.log'), 'hello-world');
  await writeFile(join(directory, 'custom.log'), 'keep');
  const events = await collect(directory, { maxFileBytes: 5 });
  assert.equal(events.filter(event => event.kind === 'rotated').length, 1);
  const archives = (await readdir(directory)).filter(name => name.endsWith('.raw'));
  assert.equal(archives.length, 1);
  assert.equal(await readFile(join(directory, archives[0]), 'utf8'), 'hello-world');
  assert.equal(await readFile(join(directory, 'custom.log'), 'utf8'), 'keep');
  await writeFile(join(directory, 'agent-insight.log'), 'new');
  await collect(directory);
  assert.equal(await readFile(join(directory, archives[0]), 'utf8'), 'hello-world');
  assert.equal((await readdir(directory)).some(name => name.endsWith('.gz')), false);
  assert.equal(await readFile(join(directory, 'agent-insight.log'), 'utf8'), 'new');
}));

test('expires only strict archive names and ignores symlinks and directories', async () => fixture(async directory => {
  const expired = historical(now - 15 * day);
  const retained = historical(now - 13 * day);
  await writeFile(join(directory, expired), 'old');
  await writeFile(join(directory, retained), 'recent');
  await writeFile(join(directory, 'agent-insight.log.notes.gz'), 'keep');
  await writeFile(join(directory, 'outside'), 'untouched');
  await symlink(join(directory, 'outside'), join(directory, historical(now - 20 * day)));
  await collect(directory);
  assert.equal((await readdir(directory)).includes(expired), false);
  assert.equal(await readFile(join(directory, retained), 'utf8'), 'recent');
  assert.equal(await readFile(join(directory, 'outside'), 'utf8'), 'untouched');
  assert.equal(await readFile(join(directory, 'agent-insight.log.notes.gz'), 'utf8'), 'keep');
}));

test('budget removes oldest histories while preserving active log', async () => fixture(async directory => {
  await writeFile(join(directory, 'agent-insight.log'), 'live');
  await writeFile(join(directory, historical(now - 3 * day)), '123456');
  await writeFile(join(directory, historical(now - 2 * day)), 'abcdef');
  await collect(directory, { maxTotalBytes: 10 });
  assert.equal((await readdir(directory)).includes(historical(now - 3 * day)), false);
  assert.equal(await readFile(join(directory, historical(now - 2 * day)), 'utf8'), 'abcdef');
  assert.equal(await readFile(join(directory, 'agent-insight.log'), 'utf8'), 'live');
}));

test('daily rotation uses birth time or first observation, not continuously updated mtime', async () => fixture(async directory => {
  await writeFile(join(directory, 'agent-insight.log'), 'first');
  await collect(directory);
  await utimes(join(directory, 'agent-insight.log'), new Date(now + day), new Date(now + day));
  const events = await collect(directory, { now: now + day + 1 });
  assert.equal(events.some(event => event.kind === 'rotated'), true);
}));

test('rotation and expiration never open large log contents', async t => fixture(async directory => {
  const archive = historical(now - day, 'raw');
  const large = await fs.open(join(directory, archive), 'w');
  await large.truncate(64 * 1024 * 1024); await large.close();
  const expired = historical(now - 15 * day, 'raw');
  await writeFile(join(directory, expired), 'expired');
  await writeFile(join(directory, 'agent-insight.log'), 'rotate me');
  const openedLogs: string[] = [];
  const original = fs.open;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    if (basename(String(args[0])).startsWith('agent-insight.log')) {
      openedLogs.push(String(args[0])); throw new Error('Log content must not be opened');
    }
    return original(...args);
  });
  const events = await collect(directory, { maxFileBytes: 1 });
  assert.deepEqual(openedLogs, []);
  assert.equal(events.some(event => event.kind === 'rotated'), true);
  assert.equal((await readdir(directory)).includes(expired), false);
  assert.equal((await stat(join(directory, archive))).size, 64 * 1024 * 1024);
  assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
}));

test('a second cleaner skips a live owner and symlink log roots are not traversed', async () => fixture(async directory => {
  await writeFile(join(directory, 'agent-insight.log'), 'hello');
  const generator = cleanupLogs({ directory, now });
  await generator.next();
  assert.equal((await collect(directory)).some(event => event.kind === 'rotated'), false);
  await generator.return(undefined);
  const alias = join(directory, 'alias');
  await symlink(directory, alias);
  assert.deepEqual(await collect(alias), []);
}));

test('dry run reports eligible logs without creating state, locks, archives, or removing files', async () => fixture(async directory => {
  await writeFile(join(directory, 'agent-insight.log'), 'large active');
  await writeFile(join(directory, historical(now - 20 * day)), 'expired');
  const before = await readdir(directory);
  const events = await collect(directory, { dryRun: true, maxFileBytes: 1 });
  assert.deepEqual(await readdir(directory), before);
  assert.equal(events.some(event => event.kind === 'scanned'), true);
  assert.equal(events.some(event => event.kind === 'deleted' || event.kind === 'rotated'), false);
}));

test('unexpired raw archives preserve concurrent appends', async () => fixture(async directory => {
  const archive = historical(now - day, 'raw');
  const path = join(directory, archive);
  await writeFile(path, Buffer.alloc(128 * 1024, 65));
  const generator = cleanupLogs({ directory, now });
  let changed = false;
  for await (const event of generator) {
    if (!changed && event.kind === 'scanned') {
      changed = true;
      await writeFile(path, 'new data', { flag: 'a' });
    }
  }
  assert.equal((await stat(path)).size, 128 * 1024 + 8);
  assert.equal((await readdir(directory)).includes(archive.replace('.raw', '.gz')), false);
}));

test('cleans abandoned compressor output while leaving unrelated temporary files alone', async () => fixture(async directory => {
  const abandoned = `${historical(now - day, 'raw')}.00000000-0000-4000-8000-000000000002.tmp`;
  await writeFile(join(directory, abandoned), 'partial gzip');
  await writeFile(join(directory, 'unrelated.tmp'), 'keep');
  await collect(directory);
  assert.equal((await readdir(directory)).includes(abandoned), false);
  assert.equal(await readFile(join(directory, 'unrelated.tmp'), 'utf8'), 'keep');
}));


test('reclaims same-host dead owners but preserves a lock from another host', async () => fixture(async directory => {
  const lock = join(directory, '.agent-insight-log-cleanup.lock');
  await writeFile(join(directory, 'agent-insight.log'), 'rotate me');
  await writeFile(lock, JSON.stringify({ host: 'a-different-host', pid: 2147483647, token: 'foreign' }));
  assert.equal((await collect(directory, { maxFileBytes: 1 })).some(event => event.kind === 'rotated'), false);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'foreign');
  await writeFile(lock, JSON.stringify({ host: hostname(), pid: 2147483647, token: 'dead' }));
  assert.equal((await collect(directory, { maxFileBytes: 1 })).some(event => event.kind === 'rotated'), true);
  assert.equal((await readdir(directory)).includes('.agent-insight-log-cleanup.lock'), false);
}));


test('stops before mutating a log root replaced with an external symlink after a yield', async () => fixture(async base => {
  const directory = join(base, 'logs');
  const outside = join(base, 'outside');
  await mkdir(directory); await mkdir(outside);
  await writeFile(join(outside, 'agent-insight.log'), 'outside data');
  const generator = cleanupLogs({ directory, now, maxFileBytes: 1 });
  await generator.next();
  await rename(directory, join(base, 'original-logs'));
  await symlink(outside, directory);
  for await (const event of generator) assert.notEqual(event.kind, 'rotated');
  assert.equal(await readFile(join(outside, 'agent-insight.log'), 'utf8'), 'outside data');
  assert.deepEqual(await readdir(outside), ['agent-insight.log']);
}));

test('stops expired archive deletion after a directory replacement', async () => fixture(async base => {
  const directory = join(base, 'logs');
  const outside = join(base, 'outside');
  await mkdir(directory); await mkdir(outside);
  const archive = historical(now - 15 * day, 'raw');
  await writeFile(join(directory, archive), 'original data');
  await writeFile(join(outside, archive), 'outside data');
  const generator = cleanupLogs({ directory, now });
  let replaced = false;
  let scanned = 0;
  for await (const event of generator) {
    if (!replaced && event.kind === 'scanned' && ++scanned === 2) {
      replaced = true;
      await rename(directory, join(base, 'original-logs'));
      await symlink(outside, directory);
    }
  }
  assert.equal(replaced, true);
  assert.equal(await readFile(join(outside, archive), 'utf8'), 'outside data');
  assert.deepEqual(await readdir(outside), [archive]);
}));

test('capacity purge deletes a bounded oldest batch without rescanning for every file', async () => fixture(async directory => {
  const names = [];
  for (let i = 0; i < 100; i++) {
    const name = `agent-insight.log.${now - day + i}.00000000-0000-4000-8000-${String(i).padStart(12, '0')}.gz`;
    names.push(name);
    await writeFile(join(directory, name), '1234567890');
  }
  const events = await collect(directory, { maxTotalBytes: 100 });
  assert.equal(events.filter(event => event.kind === 'deleted').length, 90);
  assert.ok(events.filter(event => event.kind === 'scanned').length < 300);
  const remaining = await readdir(directory);
  assert.deepEqual(remaining.filter(name => name.endsWith('.gz')).sort(), names.slice(90).sort());
}));

test('capacity deletion rechecks each candidate after yielding', async () => fixture(async directory => {
  const names = [0, 1, 2].map(i => `agent-insight.log.${now - day + i}.00000000-0000-4000-8000-${String(i).padStart(12, '0')}.gz`);
  for (const name of names) await writeFile(join(directory, name), '1234567890');
  let changed = false;
  const events = [];
  for await (const event of cleanupLogs({ directory, now, maxTotalBytes: 10 })) {
    events.push(event);
    if (!changed && event.kind === 'deleted') {
      changed = true;
      await writeFile(join(directory, names[1]), 'new');
    }
  }
  assert.equal(await readFile(join(directory, names[1]), 'utf8'), 'new');
  assert.ok(events.some(event => event.reason === 'archive-changed'));
}));

test('preserves a recovery claim instead of racing to remove a stale log owner', async () => fixture(async directory => {
  await writeFile(join(directory, 'agent-insight.log'), 'keep');
  await writeFile(join(directory, '.agent-insight-log-cleanup.lock'), JSON.stringify({ host: hostname(), pid: 2147483647, token: 'dead' }));
  await writeFile(join(directory, '.agent-insight-log-cleanup.reaping'), 'incomplete recovery');
  const events = await collect(directory, { maxFileBytes: 1 });
  assert.equal(events.some(event => event.kind === 'rotated'), false);
  assert.equal(await readFile(join(directory, 'agent-insight.log'), 'utf8'), 'keep');
}));

test('concurrent stale-owner recovery admits one cleaner', async () => fixture(async directory => {
  await writeFile(join(directory, 'agent-insight.log'), 'keep until one rotation');
  await writeFile(join(directory, '.agent-insight-log-cleanup.lock'), JSON.stringify({ host: hostname(), pid: 2147483647, token: 'dead' }));
  const first = cleanupLogs({ directory, now, maxFileBytes: 1 });
  const second = cleanupLogs({ directory, now, maxFileBytes: 1 });
  const starts = await Promise.all([first.next(), second.next()]);
  assert.equal(starts.filter(result => result.value?.kind === 'scanned').length, 1);
  assert.equal(starts.filter(result => result.value?.kind === 'skipped').length, 1);
  await first.return(undefined); await second.return(undefined);
}));
