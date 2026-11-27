import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

const ownerToken = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function validOwner(owner) {
  return owner?.version === 1 && typeof owner.host === 'string' && owner.host.length > 0
    && typeof owner.platform === 'string' && Number.isSafeInteger(owner.pid) && owner.pid > 0
    && typeof owner.token === 'string' && ownerToken.test(owner.token);
}

function inspect(file) {
  let fd;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 4096) return null;
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 4096) return null;
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 4096) return null;
    return { stat: opened, owner: JSON.parse(bytes.subarray(0, count).toString('utf8')) };
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'ELOOP'].includes(error.code) || error instanceof SyntaxError) return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

function dead(owner) {
  if (!validOwner(owner) || owner.host !== hostname() || owner.platform !== process.platform) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export function inspectProcessLock(file) {
  let stat;
  try { stat = lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return { state: 'free' }; return { state: 'blocked-unknown', reason: 'unreadable' }; }
  if (!stat.isFile()) return { state: 'blocked-unknown', reason: 'not-regular-file' };
  if (stat.size > 4096) return { state: 'blocked-unknown', reason: 'oversized-record' };
  const record = inspect(file);
  if (!record || !validOwner(record.owner)) return { state: 'blocked-unknown', reason: 'invalid-or-unreadable-owner' };
  if (record.owner.host !== hostname() || record.owner.platform !== process.platform) return { state: 'blocked-foreign' };
  return { state: dead(record.owner) ? 'orphaned' : 'held-or-unverifiable' };
}

function release(file, token) {
  if (inspect(file)?.owner?.token !== token) return;
  try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function publish(file, owner) {
  const candidate = `${file}.${owner.token}.candidate`;
  const fd = openSync(candidate, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(owner));
    fsyncSync(fd);
    try { linkSync(candidate, file); return true; }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally { closeSync(fd); unlinkSync(candidate); }
}

export function acquireProcessLock(file, depth = 0) {
  if (depth >= 8) return null;
  const owner = { version: 1, host: hostname(), platform: process.platform, pid: process.pid, token: randomUUID() };
  const recovery = `${file}.recovery`;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (existsSync(recovery)) {
      // Recover interrupted recovery with the same ownership protocol, never by age.
      const releaseClaim = acquireProcessLock(recovery, depth + 1);
      if (!releaseClaim) return null;
      releaseClaim();
      continue;
    }
    if (publish(file, owner)) {
      // A recoverer may have published its claim after our initial check.
      if (existsSync(recovery)) { release(file, owner.token); return null; }
      return () => release(file, owner.token);
    }
    const observed = inspect(file);
    if (!observed || !dead(observed.owner) || !publish(recovery, owner)) return null;
    try {
      const confirmed = inspect(file);
      if (!confirmed || confirmed.stat.dev !== observed.stat.dev || confirmed.stat.ino !== observed.stat.ino
        || confirmed.owner.token !== observed.owner.token || !dead(confirmed.owner)) return null;
      const retired = `${file}.${owner.token}.retired`;
      renameSync(file, retired);
      unlinkSync(retired);
    } finally { release(recovery, owner.token); }
  }
  return null;
}
