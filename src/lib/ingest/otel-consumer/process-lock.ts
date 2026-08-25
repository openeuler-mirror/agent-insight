import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LOCK_FILE = 'consumer-owner.lock';
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

type LockOwner = {
  pid: number;
  token: string;
  startedAt: string;
};

export type ConsumerProcessLocks = {
  paths: string[];
  release: () => void;
};

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0 && typeof parsed?.token === 'string') {
      return parsed as LockOwner;
    }
  } catch {}
  return null;
}

function removeStaleLock(lockPath: string): boolean {
  const owner = readOwner(lockPath);
  if (owner && processIsAlive(owner.pid)) return false;
  if (!owner) {
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return false;
    } catch {
      return true;
    }
  }
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

function acquireOne(spoolDir: string): { path: string; release: () => void } | null {
  fs.mkdirSync(spoolDir, { recursive: true });
  const lockPath = path.join(spoolDir, LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner: LockOwner = {
      pid: process.pid,
      token: crypto.randomUUID(),
      startedAt: new Date().toISOString(),
    };
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`, 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      let released = false;
      return {
        path: lockPath,
        release: () => {
          if (released) return;
          released = true;
          const current = readOwner(lockPath);
          if (!current || current.token !== owner.token) return;
          try {
            fs.unlinkSync(lockPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' || !removeStaleLock(lockPath)) return null;
    }
  }
  return null;
}

export function acquireConsumerProcessLocks(spoolDirs: string[]): ConsumerProcessLocks | null {
  const acquired: Array<{ path: string; release: () => void }> = [];
  const uniqueDirs = [...new Set(spoolDirs.map(dir => path.resolve(dir)))].sort();
  for (const spoolDir of uniqueDirs) {
    const lock = acquireOne(spoolDir);
    if (!lock) {
      for (const held of acquired.reverse()) held.release();
      return null;
    }
    acquired.push(lock);
  }
  let released = false;
  return {
    paths: acquired.map(lock => lock.path),
    release: () => {
      if (released) return;
      released = true;
      for (const lock of acquired.reverse()) lock.release();
    },
  };
}
