import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { cleanupEligibility, DAY_MS, type CleanupEvent } from './policy';
import { readSpoolState, readSpoolStateBySegment, markSpoolPurged, markSpoolSegmentPurged, safeSpoolSegment, trySpoolMaintenance } from './spool-state';

const MAX_METADATA_BYTES = 16 * 1024;
const streamFile = /^(logs|traces|events)\.jsonl(?:\.processed(?:\.\d+)?)?$/;
type Owner = { key?: string; segment?: string };
type Candidate = { file: string; segment?: string; bucket?: boolean };

async function realDirectory(directory: string) {
  try { return (await fsp.lstat(directory)).isDirectory() && await fsp.realpath(directory) === directory; }
  catch { return false; }
}

async function* candidates(root: string, directory = root, level = 0): AsyncGenerator<Candidate | CleanupEvent> {
  if (!await realDirectory(directory)) return;
  const entries = await fsp.opendir(directory, { bufferSize: 8 });
  for await (const entry of entries) {
    yield { kind: 'scanned' };
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const allowed = level === 0 ? /^\d{4}-\d{2}-\d{2}$/.test(entry.name) || entry.name === 'buckets'
        : level === 1 ? entry.name === 'sessions' : level === 2;
      if (allowed && level < 3) yield* candidates(root, file, level + 1);
    } else if (entry.isFile()) {
      const bucket = level === 1 && path.basename(directory) === 'buckets';
      if (bucket ? /^[a-zA-Z0-9._-]+\.jsonl$/.test(entry.name) : (level === 1 || level === 3) && streamFile.test(entry.name)) {
        yield { file, bucket, ...(level === 3 ? { segment: path.basename(directory) } : {}) };
      }
    }
  }
}

async function* legacyOwners(root: string, file: string, bucket: boolean): AsyncGenerator<CleanupEvent, Owner[] | undefined> {
  const handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const decoder = new StringDecoder('utf8');
  const keys = new Set<string>();
  const sessions = new Map<string, { key: string; marked: boolean }>();
  let tail = '';
  const consume = (line: string) => {
    if (line.length > 256 * 1024) return false;
    if (!line.trim()) return true;
    let row;
    try { row = JSON.parse(line); } catch { return false; }
    const key = bucket ? row.traceId || row.attrs?.['agentteam.session.id'] : row.sessionId;
    if (typeof key !== 'string' || !key || key.length > 512) return false;
    keys.add(key);
    if (bucket && row.attrs?.['agentteam.session.id']) {
      const session = String(row.attrs['agentteam.session.id']);
      const name = String(row.name || '');
      const marked = name.startsWith('team.') || name.startsWith('tool.task') || (name.startsWith('agent.') && name.includes('.task_iteration.'));
      sessions.set(session, { key, marked: marked || sessions.get(session)?.marked || false });
    }
    return keys.size + sessions.size <= 16;
  };
  try {
    const buffer = Buffer.alloc(64 * 1024);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      yield { kind: 'scanned', scannedBytes: bytesRead };
      tail += decoder.write(buffer.subarray(0, bytesRead));
      let start = 0;
      for (let index = tail.indexOf('\n'); index >= 0; index = tail.indexOf('\n', start)) {
        if (!consume(tail.slice(start, index))) return undefined;
        start = index + 1;
      }
      tail = tail.slice(start);
      if (tail.length > 256 * 1024) return undefined;
    }
    tail += decoder.end();
    if (tail.trim() && !consume(tail)) return undefined;
    for (const [session, { key, marked }] of sessions) {
      const taskId = readSpoolState(root, key)?.taskId;
      yield { kind: 'scanned', scannedBytes: MAX_METADATA_BYTES };
      if (marked || (taskId && taskId !== `jiuwen-${key}`)) keys.add('session:' + session);
    }
    return keys.size ? [...keys].map(key => ({ key })) : undefined;
  } finally { await handle.close(); }
}

function stateFor(root: string, owner: Owner) {
  return owner.segment !== undefined ? readSpoolStateBySegment(root, owner.segment) : readSpoolState(root, owner.key!);
}

async function* recentActivity(root: string, segment: string, now: number, days: number): AsyncGenerator<CleanupEvent, number> {
  let latest = 0;
  for (let offset = 0; offset <= days; offset++) {
    const date = new Date(now - offset * DAY_MS);
    const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dayDirectory = path.join(root, day);
    if (!await realDirectory(dayDirectory)) { yield { kind: 'scanned' }; continue; }
    const directory = path.join(dayDirectory, 'sessions', segment);
    if (await realDirectory(directory)) {
      const entries = await fsp.opendir(directory, { bufferSize: 8 });
      for await (const entry of entries) {
        if (entry.isFile() && streamFile.test(entry.name)) {
          try { latest = Math.max(latest, (await fsp.lstat(path.join(directory, entry.name))).mtimeMs); } catch { return Infinity; }
        }
        yield { kind: 'scanned' };
      }
    }
    const legacyEntries = await fsp.opendir(dayDirectory, { bufferSize: 8 });
    for await (const entry of legacyEntries) {
      yield { kind: 'scanned' };
      if (!entry.isFile() || !streamFile.test(entry.name)) continue;
      const file = path.join(dayDirectory, entry.name);
      const before = await fsp.lstat(file);
      if (before.mtimeMs <= latest || now - before.mtimeMs >= days * DAY_MS) continue;
      const owners = yield* legacyOwners(root, file, false);
      if (!owners) return Infinity;
      const after = await fsp.lstat(file);
      if (!after.isFile() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return Infinity;
      if (owners.some(owner => owner.key && safeSpoolSegment(owner.key) === segment)) latest = Math.max(latest, after.mtimeMs);
    }
    yield { kind: 'scanned' };
  }
  return latest;
}

export async function* cleanupSpool(options: {
  root: string; now?: number; normalDays?: number; abnormalDays?: number; dryRun?: boolean; onDelete?: (file: string) => void;
}): AsyncGenerator<CleanupEvent> {
  const requestedRoot = path.resolve(options.root);
  let root: string;
  try {
    if (!(await fsp.lstat(requestedRoot)).isDirectory()) return;
    root = await fsp.realpath(requestedRoot);
  } catch { return; }
  const now = options.now ?? Date.now();
  const normalDays = options.normalDays ?? 7;
  const abnormalDays = Math.max(normalDays, options.abnormalDays ?? 14);
  if (!Number.isFinite(now) || normalDays < 1 || abnormalDays > 3650 || !await realDirectory(root)) return;
  for await (const candidate of candidates(root)) {
    if ('kind' in candidate) { yield candidate; continue; }
    const { file, segment, bucket } = candidate;
    try {
      const before = await fsp.lstat(file);
      if (!before.isFile() || now - before.mtimeMs < normalDays * DAY_MS) continue;
      const owners: Owner[] | undefined = segment !== undefined ? [{ segment }] : yield* legacyOwners(root, file, !!bucket);
      if (!owners) { yield { kind: 'skipped', reason: 'legacy-ownership-unknown' }; continue; }
      let activity = before.mtimeMs;
      if (!bucket) {
        for (const owner of owners) {
          const ownerSegment = owner.segment ?? safeSpoolSegment(owner.key!);
          activity = Math.max(activity, yield* recentActivity(root, ownerSegment, now, abnormalDays));
        }
      }
      const eligible = () => owners.every(owner => {
        const state = stateFor(root, owner);
        return cleanupEligibility(state ? { ...state, lastReceivedAt: Math.max(state.lastReceivedAt, activity) }
          : { status: 'unknown', lastReceivedAt: activity }, now, normalDays, abnormalDays).eligible;
      });
      const initiallyEligible = eligible();
      yield { kind: 'scanned', scannedBytes: owners.length * MAX_METADATA_BYTES };
      if (!initiallyEligible) { yield { kind: 'skipped', reason: 'active-or-not-expired' }; continue; }
      // Reserve the bounded receipt reads for the final eligibility check and purge markers.
      yield { kind: 'scanned', scannedBytes: owners.length * MAX_METADATA_BYTES * 2 };
      if (options.dryRun) { yield { kind: 'skipped', reason: 'dry-run' }; continue; }
      const removed = trySpoolMaintenance(root, () => {
        let directory = path.dirname(file);
        while (directory !== root) {
          if (!fs.lstatSync(directory).isDirectory() || fs.realpathSync(directory) !== directory) return false;
          directory = path.dirname(directory);
        }
        if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) return false;
        const current = fs.lstatSync(file);
        if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.size !== before.size || current.mtimeMs !== before.mtimeMs || !eligible()) return false;
        for (const owner of owners) {
          const intent = { path: file, ino: current.ino, dev: current.dev, birthtimeMs: current.birthtimeMs, ctimeMs: current.ctimeMs };
          if (owner.segment !== undefined) markSpoolSegmentPurged(root, owner.segment, now, intent);
          else markSpoolPurged(root, owner.key!, now, intent);
        }
        fs.unlinkSync(file);
        return true;
      });
      if (removed) options.onDelete?.(file);
      yield removed ? { kind: 'deleted', bytes: before.size } : { kind: 'skipped', reason: 'busy-or-changed' };
    } catch { yield { kind: 'skipped', reason: 'file-unavailable-or-changed' }; }
  }
}
