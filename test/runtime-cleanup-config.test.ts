import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCleanupSweep } from '@/lib/runtime-cleanup';
import { readCleanupConfig, DAY_MS } from '@/lib/runtime-cleanup/policy';
import { noteSpoolReceived, recordSpoolPersistence } from '@/lib/runtime-cleanup/spool-state';
import { TEMPORARY_HOME_OWNER_FILE } from '@/lib/runtime-cleanup/temp';
import { activateIsolatedHome } from './helpers/isolated-home';

const hour = 3_600_000;
const archiveName = (timestamp: number) => `agent-insight.log.${timestamp}.00000000-0000-4000-8000-000000000001.gz`;

async function fixture(run: (paths: { home: string; logs: string; root: string }) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-config-'));
  const restore = activateIsolatedHome(root);
  const previousLogDirectory = process.env.AGENT_INSIGHT_LOG_DIR;
  const previousDbHost = process.env.DB_HOST;
  const home = process.env.AGENT_INSIGHT_HOME!;
  const logs = path.join(root, 'logs');
  process.env.AGENT_INSIGHT_LOG_DIR = logs;
  process.env.DB_HOST = '';
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.mkdir(logs);
    await run({ home, logs, root });
  } finally {
    if (previousLogDirectory === undefined) delete process.env.AGENT_INSIGHT_LOG_DIR;
    else process.env.AGENT_INSIGHT_LOG_DIR = previousLogDirectory;
    if (previousDbHost === undefined) delete process.env.DB_HOST;
    else process.env.DB_HOST = previousDbHost;
    restore();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function sweep(env: Record<string, string> = {}) {
  const events = [];
  for await (const event of createCleanupSweep(readCleanupConfig(env))) events.push(event);
  assert.equal(events.some(event => event.reason?.endsWith('-failed')), false, 'every cleanup category must run successfully');
  return events;
}

test('runtime sweep passes configured log size and age rotation limits', async () => fixture(async ({ logs }) => {
  const active = path.join(logs, 'agent-insight.log');
  await fs.writeFile(active, Buffer.alloc(2048, 65));
  assert.equal((await sweep()).some(event => event.kind === 'rotated'), false);
  assert.equal((await sweep({ AGENT_INSIGHT_CLEANUP_LOG_MAX_FILE_BYTES: '1024' })).some(event => event.kind === 'rotated'), true);

  await fs.writeFile(active, 'age-based log rotation');
  const stat = await fs.stat(active);
  await fs.writeFile(path.join(logs, '.agent-insight-log-state.json'), JSON.stringify({ inode: stat.ino, firstSeen: Date.now() - 2 * hour }));
  assert.equal((await sweep()).some(event => event.kind === 'rotated'), false);
  assert.equal((await sweep({ AGENT_INSIGHT_CLEANUP_LOG_ROTATE_HOURS: '1' })).some(event => event.kind === 'rotated'), true);
}));

test('runtime sweep passes configured log retention and total size limits', async () => fixture(async ({ logs }) => {
  const now = Date.now();
  const older = path.join(logs, archiveName(now - 2 * DAY_MS));
  await fs.writeFile(older, 'retained for fourteen days by default');
  await sweep();
  await fs.stat(older);
  await sweep({ AGENT_INSIGHT_CLEANUP_LOG_RETENTION_DAYS: '1' });
  await assert.rejects(fs.stat(older), { code: 'ENOENT' });

  const oldest = path.join(logs, archiveName(now - 3 * hour));
  const newest = path.join(logs, archiveName(now - 2 * hour));
  await fs.writeFile(oldest, Buffer.alloc(700 * 1024));
  await fs.writeFile(newest, Buffer.alloc(700 * 1024));
  await sweep();
  await fs.stat(oldest);
  await sweep({ AGENT_INSIGHT_CLEANUP_LOG_MAX_FILE_BYTES: '1024', AGENT_INSIGHT_CLEANUP_LOG_MAX_TOTAL_BYTES: '1048576' });
  await assert.rejects(fs.stat(oldest), { code: 'ENOENT' });
  await fs.stat(newest);
}));

test('runtime sweep passes configured temporary-home retention', async () => fixture(async ({ home }) => {
  const temporaryHome = path.join(home, 'data', '.opencode-runtime', 'user', 'isolated-home-config');
  await fs.mkdir(temporaryHome, { recursive: true });
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await once(child, 'exit');
  await fs.writeFile(path.join(temporaryHome, TEMPORARY_HOME_OWNER_FILE), JSON.stringify({
    version: 1, hostname: os.hostname(), ownerPid: pid, processGroupId: pid, createdAt: Date.now() - 36 * hour,
  }));
  await fs.writeFile(path.join(temporaryHome, 'temporary-content'), 'expired only with the shorter configured retention');
  await sweep({ AGENT_INSIGHT_CLEANUP_TEMP_RETENTION_HOURS: '48' });
  await fs.stat(temporaryHome);
  await sweep({ AGENT_INSIGHT_CLEANUP_TEMP_RETENTION_HOURS: '24' });
  await assert.rejects(fs.stat(temporaryHome), { code: 'ENOENT' });
}));

test('runtime sweep passes normal and abnormal spool retention overrides', async () => fixture(async ({ home }) => {
  const root = path.join(home, 'otel_data', 'claude');
  const now = Date.now();
  const writeCache = async (key: string, age: number, failed: boolean) => {
    const receivedAt = now - age * DAY_MS;
    const date = new Date(receivedAt);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const file = path.join(root, day, 'sessions', key, 'logs.jsonl');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ sessionId: key }) + '\n');
    await fs.utimes(file, date, date);
    const generation = noteSpoolReceived(root, key, receivedAt);
    recordSpoolPersistence(root, key, generation, { completedAt: receivedAt, failed });
    return file;
  };
  const normal = await writeCache('normal-config', 8, false);
  const abnormal = await writeCache('abnormal-config', 15, true);
  await sweep({ AGENT_INSIGHT_OTEL_SPOOL_RETENTION_DAYS: '10', AGENT_INSIGHT_CLEANUP_ABNORMAL_DAYS: '20' });
  await fs.stat(normal);
  await fs.stat(abnormal);
  await sweep();
  await assert.rejects(fs.stat(normal), { code: 'ENOENT' });
  await assert.rejects(fs.stat(abnormal), { code: 'ENOENT' });
}));
