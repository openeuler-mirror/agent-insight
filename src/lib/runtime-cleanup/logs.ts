import { constants } from 'node:fs';
import { link, lstat, open, opendir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const DAY = 86_400_000;
const ACTIVE = 'agent-insight.log';
const ARCHIVE = /^agent-insight\.log\.(\d{13})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(raw|gz)$/;
const TEMPORARY = /^agent-insight\.log\.(\d{13})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.raw\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export interface LogCleanupOptions {
  directory: string;
  now?: number;
  retentionDays?: number;
  rotateAfterMs?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  dryRun?: boolean;
}
export interface LogCleanupEvent {
  kind: 'scanned' | 'deleted' | 'rotated' | 'skipped';
  bytes?: number;
  scannedBytes?: number;
  reason?: string;
}

type RootGuard = () => Promise<void>;
type Owner = { pid: number; host: string; token: string };
async function readSmallJson(path: string): Promise<Record<string, unknown> | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > 4096) return;
    return JSON.parse(await handle.readFile('utf8'));
  } catch { return; } finally { await handle?.close(); }
}

async function acquire(directory: string, guard: RootGuard): Promise<(() => Promise<void>) | undefined> {
  await guard();
  const path = join(directory, '.agent-insight-log-cleanup.lock');
  const owner: Owner = { pid: process.pid, host: hostname(), token: randomUUID() };
  const reaping = join(directory, '.agent-insight-log-cleanup.reaping');
  const recovery = await open(reaping, 'wx', 0o600).catch(() => undefined);
  if (!recovery) return;
  try {
    await recovery.writeFile(JSON.stringify(owner));
    const previous = await readSmallJson(path);
    if (previous?.host === owner.host && Number.isInteger(previous.pid) && Number(previous.pid) > 0) {
      try { process.kill(Number(previous.pid), 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          const current = await readSmallJson(path);
          if (current?.token === previous.token) { await guard(); await unlink(path).catch(() => undefined); }
        }
      }
    }
    const pending = join(directory, `.agent-insight-log-lock.${owner.token}.tmp`);
    let handle: FileHandle | undefined;
    try {
      await guard();
      handle = await open(pending, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(owner));
      await handle.close(); handle = undefined;
      // Publish a complete owner atomically; a crash cannot leave an empty permanent lock.
      await guard();
      await link(pending, path);
    } catch { return; }
    finally {
      await handle?.close();
      await guard().then(() => unlink(pending)).catch(() => undefined);
    }
    return async () => {
      try { await guard(); } catch { return; }
      const current = await readSmallJson(path);
      if (current?.token === owner.token) await guard().then(() => unlink(path)).catch(() => undefined);
    };
  } finally {
    await recovery.close();
    try {
      await guard();
      const current = await readSmallJson(reaping);
      if (current?.token === owner.token) await unlink(reaping);
    } catch { /* An interrupted recovery is kept for manual inspection. */ }
  }
}

async function* archiveEntries(directory: string, guard: RootGuard) {
  await guard();
  const entries = await opendir(directory, { bufferSize: 16 });
  for await (const entry of entries) {
    await guard();
    const match = ARCHIVE.exec(entry.name) ?? TEMPORARY.exec(entry.name);
    if (!match || !entry.isFile()) { yield undefined; continue; }
    const path = join(directory, entry.name);
    const info = await lstat(path).catch(() => undefined);
    if (!info?.isFile()) { yield undefined; continue; }
    yield { name: entry.name, path, timestamp: Number(match[1]), format: match[3] ?? 'tmp', info };
  }
}

export async function* cleanupLogs(options: LogCleanupOptions): AsyncGenerator<LogCleanupEvent> {
  const { directory } = options;
  const now = options.now ?? Date.now();
  const maxFileBytes = options.maxFileBytes ?? 50 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 1024 * 1024 * 1024;
  const retentionDays = options.retentionDays ?? 14;
  const rotateAfterMs = options.rotateAfterMs ?? DAY;
  if (![now, maxFileBytes, maxTotalBytes, retentionDays, rotateAfterMs].every(Number.isFinite) || maxFileBytes <= 0 || maxTotalBytes < 0 || retentionDays <= 0 || rotateAfterMs <= 0) return;
  const root = await lstat(directory).catch(() => undefined);
  if (!root?.isDirectory() || root.isSymbolicLink()) return;
  const canonicalRoot = await realpath(directory);
  const guard: RootGuard = async () => {
    const current = await lstat(directory);
    if (!current.isDirectory() || current.ino !== root.ino || current.dev !== root.dev
      || await realpath(directory) !== canonicalRoot) throw new Error('Log directory changed during cleanup');
  };
  if (options.dryRun) {
    const active = await lstat(join(directory, ACTIVE)).catch(() => undefined);
    if (active?.isFile()) yield { kind: 'scanned', reason: 'dry-run-active-log' };
    for await (const archive of archiveEntries(directory, guard)) {
      yield { kind: 'scanned', reason: archive && now - archive.timestamp >= retentionDays * DAY ? 'dry-run-expired-log' : 'dry-run' };
    }
    return;
  }
  const release = await acquire(directory, guard);
  if (!release) { yield { kind: 'skipped' }; return; }
  try {
    yield { kind: 'scanned' };
    await guard();
    const activePath = join(directory, ACTIVE);
    const active = await lstat(activePath).catch(() => undefined);
    let rotated: string | undefined;
    if (active?.isFile()) {
      const statePath = join(directory, '.agent-insight-log-state.json');
      const state = await readSmallJson(statePath);
      const firstSeen = state?.inode === active.ino && typeof state?.firstSeen === 'number'
        ? state.firstSeen : Math.min(now, active.birthtimeMs > 0 ? active.birthtimeMs : now);
      if (active.size >= maxFileBytes || (active.size > 0 && now - firstSeen >= rotateAfterMs)) {
        rotated = `agent-insight.log.${now}.${randomUUID()}.raw`;
        await guard();
        await rename(activePath, join(directory, rotated));
        yield { kind: 'rotated' };
      } else {
        await guard();
        const stateFile = await open(statePath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try { await stateFile.writeFile(JSON.stringify({ inode: active.ino, firstSeen })); }
        finally { await stateFile.close(); }
      }
    }
    for await (const archive of archiveEntries(directory, guard)) {
      yield { kind: 'scanned' };
      await guard();
      if (!archive || archive.name === rotated) continue;
      if (archive.format === 'tmp' || now - archive.timestamp >= retentionDays * DAY) {
        await guard();
        await unlink(archive.path);
        yield { kind: 'deleted', bytes: archive.info.size };
      }
    }
    while (true) {
      await guard();
      const currentActive = await lstat(activePath).catch(() => undefined);
      let total = currentActive?.isFile() ? currentActive.size : 0;
      type Candidate = { path: string; timestamp: number; info: Awaited<ReturnType<typeof lstat>> };
      const oldest: Candidate[] = [];
      for await (const archive of archiveEntries(directory, guard)) {
        yield { kind: 'scanned' };
        await guard();
        if (!archive) continue;
        total += archive.info.size;
        if (archive.name === rotated) continue;
        const candidate = { path: archive.path, timestamp: archive.timestamp, info: archive.info };
        let low = 0;
        let high = oldest.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          const other = oldest[middle];
          if (other.timestamp < candidate.timestamp || (other.timestamp === candidate.timestamp && other.path < candidate.path)) low = middle + 1;
          else high = middle;
        }
        if (low < 256) {
          oldest.splice(low, 0, candidate);
          if (oldest.length > 256) oldest.pop();
        }
      }
      if (total <= maxTotalBytes || !oldest.length) break;
      let removed = 0;
      for (const candidate of oldest) {
        if (total <= maxTotalBytes) break;
        await guard();
        const current = await lstat(candidate.path).catch(() => undefined);
        if (!current?.isFile() || current.ino !== candidate.info.ino || current.dev !== candidate.info.dev
          || current.size !== candidate.info.size || current.mtimeMs !== candidate.info.mtimeMs) {
          yield { kind: 'skipped', reason: 'archive-changed' };
          continue;
        }
        await guard();
        await unlink(candidate.path);
        total -= current.size;
        removed++;
        yield { kind: 'deleted', bytes: current.size };
      }
      if (total <= maxTotalBytes || removed === 0) break;
    }
  } catch { yield { kind: 'skipped' }; }
  finally { await release(); }
}
