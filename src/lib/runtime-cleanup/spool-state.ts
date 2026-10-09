import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const MAX_JSON_BYTES = 16 * 1024;
const MAX_LEASES = 32;
type Owner = { pid: number; host: string; token: string };
export type SpoolPurgeIntent = { path: string; ino: number; dev: number; birthtimeMs?: number; ctimeMs?: number };
export type SpoolState = {
  version: 1;
  key?: string;
  generation: string;
  status: 'running' | 'success' | 'failed' | 'unknown';
  lastReceivedAt: number;
  completedAt?: number;
  purgedAt?: number;
  purgeIntent?: SpoolPurgeIntent;
  taskId?: string;
};

export function safeSpoolSegment(key: string): string {
  const raw = String(key || 'unknown').trim() || 'unknown';
  const sanitized = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'session';
  if (sanitized === raw && raw !== '.' && raw !== '..' && raw.length <= 80) return raw;
  return `${sanitized}-${createHash('sha1').update(raw).digest('hex').slice(0, 10)}`;
}
function validSegment(segment: string) {
  return /^[a-zA-Z0-9._-]{1,128}$/.test(segment) && segment !== '.' && segment !== '..';
}
function directory(target: string, create = false): boolean {
  try {
    if (create && !fs.existsSync(target)) fs.mkdirSync(target, { mode: 0o700 });
    const info = fs.lstatSync(target);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch { return false; }
}
function metadata(root: string, create = false): string | undefined {
  if (!directory(root)) return;
  const base = path.join(root, '.retention-v1');
  if (!directory(base, create)) return;
  for (const child of ['states', 'uses', 'locks']) if (!directory(path.join(base, child), create)) return;
  return base;
}
function readJson(file: string): unknown {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size > MAX_JSON_BYTES) return null;
    const bytes = Buffer.alloc(info.size);
    const count = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    if (count !== info.size) return null;
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? undefined : null; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function owner(value: unknown): value is Owner {
  const record = value as Partial<Owner> | null;
  return Boolean(record && typeof record.host === 'string' && Number.isInteger(record.pid) && record.pid! > 0 && typeof record.token === 'string');
}
function dead(value: unknown): value is Owner {
  if (!owner(value) || value.host !== os.hostname()) return false;
  try { process.kill(value.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function removeDead(file: string): boolean {
  const previous = readJson(file);
  if (previous === undefined) return true;
  if (!dead(previous)) return false;
  const current = readJson(file);
  if (!owner(current) || current.token !== previous.token) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}
function publish(file: string, value: unknown, exclusive: boolean): void {
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > MAX_JSON_BYTES) throw new Error('Spool metadata exceeds size limit');
  const temporary = path.join(path.dirname(file), `.pending-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    if (exclusive) fs.linkSync(temporary, file);
    else fs.renameSync(temporary, file);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}
function claim(file: string): (() => void) | undefined {
  const reaping = `${file}.reaping`;
  if (readJson(reaping) !== undefined) return;
  const record: Owner = { pid: process.pid, host: os.hostname(), token: randomUUID() };
  const previous = readJson(file);
  let ownsReaper = false;
  try {
    if (previous !== undefined) {
      if (!dead(previous)) return;
      publish(reaping, record, true);
      ownsReaper = true;
      const current = readJson(file);
      if (!owner(current) || current.token !== previous.token || !dead(current)) return;
      fs.unlinkSync(file);
    }
    publish(file, record, true);
    if (!ownsReaper && readJson(reaping) !== undefined) {
      const current = readJson(file);
      if (owner(current) && current.token === record.token) fs.unlinkSync(file);
      return;
    }
  } catch { return; }
  finally {
    // An abandoned reaper requires inspection; recursively reclaiming it recreates the same race.
    if (ownsReaper) {
      const current = readJson(reaping);
      if (owner(current) && current.token === record.token) {
        try { fs.unlinkSync(reaping); } catch {}
      }
    }
  }
  return () => {
    const current = readJson(file);
    if (owner(current) && current.token === record.token) {
      try { fs.unlinkSync(file); } catch {}
    }
  };
}
function maintenanceBlocks(file: string): boolean {
  if (readJson(`${file}.reaping`) !== undefined) return true;
  const current = readJson(file);
  return current !== undefined && !dead(current);
}
export function acquireSpoolUse(root: string): (() => void) | null {
  const base = metadata(root, true);
  if (!base) return null;
  const maintenance = path.join(base, 'maintenance.lock');
  if (maintenanceBlocks(maintenance)) return null;
  const file = path.join(base, 'uses', `${randomUUID()}.json`);
  const release = claim(file);
  if (!release) return null;
  if (maintenanceBlocks(maintenance)) { release(); return null; }
  return release;
}
export function trySpoolMaintenance<T>(root: string, callback: () => T): T | undefined {
  const base = metadata(root, true);
  if (!base) return;
  const release = claim(path.join(base, 'maintenance.lock'));
  if (!release) return;
  try {
    let entries: fs.Dir | undefined;
    try {
      entries = fs.opendirSync(path.join(base, 'uses'), { bufferSize: 1 });
      for (let count = 0; count <= MAX_LEASES; count++) {
        const entry = entries.readSync();
        if (!entry) break;
        if (count === MAX_LEASES || !entry.isFile() || !removeDead(path.join(base, 'uses', entry.name))) return;
      }
    } catch { return; }
    finally { entries?.closeSync(); }
    return callback();
  } finally { release(); }
}
function statePath(base: string, segment: string) {
  return path.join(base, 'states', `${createHash('sha256').update(segment).digest('hex')}.json`);
}
function corrupt(): SpoolState {
  return { version: 1, generation: '', status: 'unknown', lastReceivedAt: Number.NaN };
}
function readRawSpoolStateBySegment(root: string, segment: string): SpoolState | undefined {
  if (!validSegment(segment)) return;
  const base = metadata(root);
  if (!base) {
    try { if (fs.lstatSync(path.join(root, '.retention-v1'))) return corrupt(); } catch {}
    return;
  }
  const value = readJson(statePath(base, segment));
  if (value === undefined) return;
  if (!value || typeof value !== 'object') return corrupt();
  const state = value as SpoolState;
  if (state.version !== 1 || typeof state.generation !== 'string' || !['running', 'success', 'failed', 'unknown'].includes(state.status)
    || !Number.isFinite(state.lastReceivedAt) || state.lastReceivedAt < 0
    || (state.completedAt !== undefined && (!Number.isFinite(state.completedAt) || state.completedAt < 0))
    || (state.purgedAt !== undefined && (!Number.isFinite(state.purgedAt) || state.purgedAt < 0))
    || (state.key !== undefined && (typeof state.key !== 'string' || safeSpoolSegment(state.key) !== segment))
    || (state.taskId !== undefined && typeof state.taskId !== 'string')
    || (state.purgeIntent !== undefined && !validPurgeIntent(state.purgeIntent))
    || (state.status === 'success' && (!state.completedAt || !state.generation))) return corrupt();
  return state;
}
function validPurgeIntent(intent: SpoolPurgeIntent): boolean {
  return Boolean(intent && typeof intent.path === 'string' && path.isAbsolute(intent.path) && intent.path.length <= 4096
    && Number.isFinite(intent.ino) && intent.ino >= 0 && Number.isFinite(intent.dev) && intent.dev >= 0
    && (intent.birthtimeMs === undefined || Number.isFinite(intent.birthtimeMs))
    && (intent.ctimeMs === undefined || Number.isFinite(intent.ctimeMs)));
}
function effectiveState(state: SpoolState): SpoolState {
  if (state.purgedAt !== undefined && state.purgeIntent) {
    try {
      const file = fs.lstatSync(state.purgeIntent.path);
      const sameCreation = state.purgeIntent.birthtimeMs && state.purgeIntent.birthtimeMs > 0
        ? file.birthtimeMs === state.purgeIntent.birthtimeMs
        : state.purgeIntent.ctimeMs === undefined || file.ctimeMs === state.purgeIntent.ctimeMs;
      if (file.isFile() && file.ino === state.purgeIntent.ino && file.dev === state.purgeIntent.dev && sameCreation) {
        const { purgedAt: _pending, ...intact } = state;
        return intact;
      }
    } catch {}
  }
  return state;
}
export function readSpoolStateBySegment(root: string, segment: string): SpoolState | undefined {
  const state = readRawSpoolStateBySegment(root, segment);
  return state ? effectiveState(state) : undefined;
}
export function readSpoolState(root: string, key: string): SpoolState | undefined {
  return readSpoolStateBySegment(root, safeSpoolSegment(key));
}
function update(root: string, segment: string, change: (previous: SpoolState | undefined) => SpoolState | undefined): void {
  const base = metadata(root, true);
  if (!base) throw new Error('Spool metadata directory is unavailable');
  const file = statePath(base, segment);
  const release = claim(path.join(base, 'locks', `${createHash('sha256').update(segment).digest('hex')}.lock`));
  if (!release) throw new Error('Spool metadata is in use');
  try {
    const previous = readRawSpoolStateBySegment(root, segment);
    if (previous && !Number.isFinite(previous.lastReceivedAt)) throw new Error('Spool metadata is corrupt');
    const next = change(previous);
    if (next) publish(file, next, false);
  } finally { release(); }
}
export function noteSpoolReceived(root: string, key: string, now = Date.now()): string {
  if (!Number.isFinite(now) || now <= 0) throw new Error('Invalid receipt time');
  const release = acquireSpoolUse(root);
  if (!release) throw new Error('Spool maintenance is in progress');
  const generation = randomUUID();
  try {
    update(root, safeSpoolSegment(key), previous => ({ version: 1, key, generation, status: 'unknown', lastReceivedAt: now,
      ...(previous?.purgedAt === undefined ? {} : { purgedAt: previous.purgedAt, ...(previous.purgeIntent ? { purgeIntent: previous.purgeIntent } : {}) }),
      ...(previous?.taskId === undefined ? {} : { taskId: previous.taskId }) }));
    return generation;
  } finally { release(); }
}
export function recordSpoolPersistence(root: string, key: string, generation: string, result: { completedAt?: number; failed?: boolean; taskId?: string }): void {
  const release = acquireSpoolUse(root);
  if (!release) throw new Error('Spool maintenance is in progress');
  try {
    update(root, safeSpoolSegment(key), previous => {
      if (!previous || previous.generation !== generation) return;
      const completedAt = typeof result.completedAt === 'number' && Number.isFinite(result.completedAt) && result.completedAt > 0 ? result.completedAt : undefined;
      const status = result.failed ? 'failed' : completedAt ? 'success' : 'running';
      return { ...previous, status, completedAt: status === 'success' ? completedAt : undefined, taskId: result.taskId ?? previous.taskId };
    });
  } finally { release(); }
}
export function markSpoolSegmentPurged(root: string, segment: string, now = Date.now(), intent?: SpoolPurgeIntent): void {
  if (!validSegment(segment) || !Number.isFinite(now) || now <= 0 || (intent && !validPurgeIntent(intent))) throw new Error('Invalid spool purge marker');
  update(root, segment, previous => {
    if (previous && effectiveState(previous).purgedAt !== undefined) return previous;
    return { ...(previous ?? { version: 1, generation: randomUUID(), status: 'unknown', lastReceivedAt: 0 }), purgedAt: now, purgeIntent: intent };
  });
}
export function markSpoolPurged(root: string, key: string, now = Date.now(), intent?: SpoolPurgeIntent): void {
  markSpoolSegmentPurged(root, safeSpoolSegment(key), now, intent);
}
