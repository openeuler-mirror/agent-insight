import fs from 'node:fs';
import path from 'node:path';
import { invalidateCursor, loadCheckpoint, toCheckpointRelPath } from './checkpoint';
import { removeLegacySessionIndex } from '@/lib/ingest/claude-otel/legacy-session-index';

export type RetentionResult = {
  archived: number;
  skipped: number;
};

function dayFromRelPath(relPath: string): string | null {
  const day = relPath.split('/')[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function archiveTarget(file: string): string {
  const base = `${file}.processed`;
  if (!fs.existsSync(base)) return base;
  return `${base}.${Date.now()}`;
}

export function compactProcessedSpoolFiles(
  spoolDir: string,
  files: string[],
  retentionDays: number,
  now = new Date(),
): RetentionResult {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) return { archived: 0, skipped: files.length };
  const checkpoint = loadCheckpoint(spoolDir);
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  let archived = 0;
  let skipped = 0;

  for (const file of files) {
    const relPath = toCheckpointRelPath(spoolDir, file);
    const day = dayFromRelPath(relPath);
    const dayTime = day ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN;
    if (!Number.isFinite(dayTime) || dayTime >= cutoff) {
      skipped += 1;
      continue;
    }

    const cursor = checkpoint.files[relPath];
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      skipped += 1;
      continue;
    }

    if (!cursor || cursor.bytes < size) {
      skipped += 1;
      continue;
    }

    fs.renameSync(file, archiveTarget(file));
    // 旁路索引跟着原文件一起走,别在磁盘上留下指向已归档文件的孤儿索引。
    removeLegacySessionIndex(file);
    invalidateCursor(spoolDir, relPath);
    archived += 1;
  }

  return { archived, skipped };
}
