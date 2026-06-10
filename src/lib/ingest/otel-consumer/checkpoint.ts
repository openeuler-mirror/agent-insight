import fs from 'node:fs';
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

export function loadCheckpoint(spoolDir: string): ConsumerCheckpoint {
  const file = checkpointFilePath(spoolDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version === 1 && parsed.files && typeof parsed.files === 'object') {
      return { version: 1, files: parsed.files };
    }
  } catch {}
  return { version: 1, files: {} };
}

function writeCheckpoint(spoolDir: string, checkpoint: ConsumerCheckpoint): void {
  fs.mkdirSync(spoolDir, { recursive: true });
  const file = checkpointFilePath(spoolDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

export function getFileCursor(spoolDir: string, relPath: string): SpoolCursor {
  const checkpoint = loadCheckpoint(spoolDir);
  return { bytes: checkpoint.files[relPath]?.bytes || 0 };
}

export function saveFileCursor(spoolDir: string, relPath: string, cursor: SpoolCursor): void {
  const checkpoint = loadCheckpoint(spoolDir);
  const previous = checkpoint.files[relPath]?.bytes || 0;
  checkpoint.files[relPath] = {
    bytes: Math.max(previous, cursor.bytes || 0),
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
  try {
    const days = fs.readdirSync(spoolDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const day of days) {
      const dir = path.join(spoolDir, day.name);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dir).filter((file) => file.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) out.push(path.join(dir, file));
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
