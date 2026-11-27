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
import type { ClaudeOtelAppendResult, ClaudeOtelEvent } from '@/lib/ingest/claude-otel/types';
import {
  appendClaudeOtelEvents,
  listClaudeOtelSpoolFiles,
  readClaudeOtelEventsForSession,
} from '@/lib/ingest/claude-otel/spool';

export type CodeAgentOtelEvent = ClaudeOtelEvent;

export function getCodeAgentOtelSpoolDir(): string {
  return process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SPOOL_DIR ||
    path.join(getExistingInsightDir(), 'otel_data', 'codeagent');
}

export function appendCodeAgentOtelEvents(
  events: CodeAgentOtelEvent[],
  spoolDir = getCodeAgentOtelSpoolDir(),
): ClaudeOtelAppendResult {
  return appendClaudeOtelEvents(events, spoolDir);
}

export function listCodeAgentOtelSpoolFiles(spoolDir = getCodeAgentOtelSpoolDir()): string[] {
  return listClaudeOtelSpoolFiles(spoolDir);
}

export function readCodeAgentOtelEventsForSession(
  sessionId: string,
  spoolDir = getCodeAgentOtelSpoolDir(),
): CodeAgentOtelEvent[] {
  return readClaudeOtelEventsForSession(sessionId, spoolDir);
}
