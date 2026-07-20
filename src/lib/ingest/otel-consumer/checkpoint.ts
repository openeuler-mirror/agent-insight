import fs from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';
import type { SpoolCursor } from '@/lib/ingest/claude-otel/spool';

export type CheckpointEntry = SpoolCursor & {
  updatedAt: string;
};

export type ConsumerCheckpoint = {
  version: 1;
  files: Record<string, CheckpointEntry>;
};

export function checkpointFilePath(spoolDir: string): string {
  return path.join(spoolDir, 'consumer-checkpoint.json');
}

export function toCheckpointRelPath(spoolDir: string, file: string): string {
  return path.relative(spoolDir, file).split(path.sep).join('/');
}

// 每 spoolDir 一份内存缓存。consumer tick 每秒对"每个 spool 文件"各查一次游标,
// 若每次都 readFileSync + JSON.parse 整个 checkpoint(几百条目),几百个文件时
// tick 固定开销 = 每秒几十上百 MB 的 JSON 解析,单核被烧满(线上事故实锤)。
// 写路径保持"每次落盘"(频率 = 聚合完成次数,很低),缓存与磁盘同步更新。
// 注意:进程外直接改 checkpoint 文件(如运维置 0 游标触发重放)后必须重启服务,
// 否则内存缓存感知不到——运维重放流程本来就以 restart 收尾,语义不变。
const checkpointCache = new Map<string, ConsumerCheckpoint>();

export function invalidateCheckpointCache(spoolDir?: string): void {
  if (spoolDir === undefined) checkpointCache.clear();
  else checkpointCache.delete(spoolDir);
}

export function loadCheckpoint(spoolDir: string): ConsumerCheckpoint {
  const cached = checkpointCache.get(spoolDir);
  if (cached) return cached;
  const file = checkpointFilePath(spoolDir);
  let checkpoint: ConsumerCheckpoint = { version: 1, files: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === 'object') {
      checkpoint = { version: 1, files: parsed.files };
    }
  } catch {}
  checkpointCache.set(spoolDir, checkpoint);
  return checkpoint;
}

function writeCheckpoint(spoolDir: string, checkpoint: ConsumerCheckpoint): void {
  fs.mkdirSync(spoolDir, { recursive: true });
  const file = checkpointFilePath(spoolDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
  checkpointCache.set(spoolDir, checkpoint);
}

export function getFileCursor(spoolDir: string, relPath: string): SpoolCursor {
  const checkpoint = loadCheckpoint(spoolDir);
  return { bytes: checkpoint.files[relPath]?.bytes || 0 };
}

export function saveFileCursor(spoolDir: string, relPath: string, cursor: SpoolCursor): void {
  const checkpoint = loadCheckpoint(spoolDir);
  checkpoint.files[relPath] = {
    bytes: Math.max(0, cursor.bytes || 0),
    updatedAt: new Date().toISOString(),
  };
  writeCheckpoint(spoolDir, checkpoint);
}

export function invalidateCursor(spoolDir: string, relPath: string): void {
  const checkpoint = loadCheckpoint(spoolDir);
  if (!checkpoint.files[relPath]) return;
  delete checkpoint.files[relPath];
  writeCheckpoint(spoolDir, checkpoint);
}

function listJsonlFiles(spoolDir: string): string[] {
  const out: string[] = [];
  const collect = (dir: string) => {
    let entries: Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collect(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(fullPath);
      }
    }
  };
  try {
    const days = fs.readdirSync(spoolDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const day of days) {
      collect(path.join(spoolDir, day.name));
    }
  } catch {}
  return out.sort();
}

export function hasCheckpoint(spoolDir: string): boolean {
  return fs.existsSync(checkpointFilePath(spoolDir));
}

export function seedToEof(spoolDir: string, files = listJsonlFiles(spoolDir)): void {
  if (hasCheckpoint(spoolDir)) return;
  const checkpoint: ConsumerCheckpoint = { version: 1, files: {} };
  const now = new Date().toISOString();
  for (const file of files) {
    try {
      const relPath = toCheckpointRelPath(spoolDir, file);
      checkpoint.files[relPath] = { bytes: fs.statSync(file).size, updatedAt: now };
    } catch {}
  }
  writeCheckpoint(spoolDir, checkpoint);
}
