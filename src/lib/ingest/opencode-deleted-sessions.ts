/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getExistingInsightDir, getPreferredInsightDir } from '@/lib/agent-insight-paths';

const DEFAULT_TOMBSTONE_FILE = path.join(getExistingInsightDir(), 'opencode_deleted_sessions.json');

function tombstoneFilePath(): string {
  return process.env.AGENT_INSIGHT_OPENCODE_DELETED_SESSIONS || DEFAULT_TOMBSTONE_FILE;
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

  fs.mkdirSync(path.dirname(filePath || path.join(getPreferredInsightDir(), 'placeholder')), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({ sessionIds: Array.from(merged).sort(), updatedAt: new Date().toISOString() }, null, 2),
  );
  return merged.size - before;
}
