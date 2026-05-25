import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TOMBSTONE_FILE = path.join(os.homedir(), '.skill-insight', 'opencode_deleted_sessions.json');

function tombstoneFilePath(): string {
  return process.env.SKILL_INSIGHT_OPENCODE_DELETED_SESSIONS || DEFAULT_TOMBSTONE_FILE;
}

function normalizeSessionId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readDeletedSessionIds(filePath = tombstoneFilePath()): Set<string> {
  try {
    if (!fs.existsSync(filePath)) return new Set();
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const rawIds = Array.isArray(parsed) ? parsed : parsed?.sessionIds;
    if (!Array.isArray(rawIds)) return new Set();
    return new Set(rawIds.map(normalizeSessionId).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function isDeletedOpencodeSessionId(sessionId: unknown): boolean {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) return false;
  return readDeletedSessionIds().has(normalized);
}

export function addDeletedOpencodeSessionIds(sessionIds: unknown[]): number {
  const incoming = sessionIds.map(normalizeSessionId).filter(Boolean);
  if (incoming.length === 0) return 0;

  const filePath = tombstoneFilePath();
  const merged = readDeletedSessionIds(filePath);
  const before = merged.size;
  for (const id of incoming) merged.add(id);
  if (merged.size === before) return 0;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ sessionIds: Array.from(merged).sort(), updatedAt: new Date().toISOString() }, null, 2),
  );
  return merged.size - before;
}
