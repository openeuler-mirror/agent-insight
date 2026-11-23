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
