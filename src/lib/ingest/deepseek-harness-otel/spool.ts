import path from 'node:path';

import { getExistingInsightDir } from '@/lib/agent-insight-paths';
import {
  appendJsonlBySession,
  listJsonlSpoolFiles,
  readEventsForSession,
} from '@/lib/ingest/claude-otel/spool';
import type {
  DeepSeekHarnessOtelAppendResult,
  DeepSeekHarnessOtelEvent,
} from './types';

const FILE_NAME = 'events.jsonl';

export function getDeepSeekHarnessOtelSpoolDir(): string {
  return process.env.AGENT_INSIGHT_DEEPSEEK_HARNESS_OTEL_SPOOL_DIR
    || path.join(getExistingInsightDir(), 'otel_data', 'deepseek-harness');
}

export function appendDeepSeekHarnessOtelEvents(
  events: DeepSeekHarnessOtelEvent[],
  spoolDir = getDeepSeekHarnessOtelSpoolDir(),
): DeepSeekHarnessOtelAppendResult {
  const rows = events.flatMap((event) => {
    const sourceSessionId = event.sourceSessionId || event.sessionId;
    const own = { ...event, sourceSessionId };
    const parentSessionId = typeof event.attributes?.['session.parent_id'] === 'string'
      ? event.attributes['session.parent_id'].trim()
      : '';
    return parentSessionId && parentSessionId !== event.sessionId
      ? [own, { ...own, sessionId: parentSessionId }]
      : [own];
  });
  const dirtySessionIds = Array.from(new Set(rows.map((event) => event.sessionId).filter(Boolean)));
  if (rows.length > 0) appendJsonlBySession(spoolDir, FILE_NAME, rows);
  return { events, dirtySessionIds };
}

export function listDeepSeekHarnessOtelSpoolFiles(
  spoolDir = getDeepSeekHarnessOtelSpoolDir(),
): string[] {
  return listJsonlSpoolFiles(spoolDir, FILE_NAME);
}

export function listDeepSeekHarnessOtelSpoolFilesForDay(
  day: string,
  spoolDir = getDeepSeekHarnessOtelSpoolDir(),
): string[] {
  return listJsonlSpoolFiles(path.join(spoolDir, day), FILE_NAME);
}

export function readDeepSeekHarnessOtelEventsForSession(
  sessionId: string,
  spoolDir = getDeepSeekHarnessOtelSpoolDir(),
): DeepSeekHarnessOtelEvent[] {
  return readEventsForSession<DeepSeekHarnessOtelEvent>(spoolDir, FILE_NAME, sessionId);
}
