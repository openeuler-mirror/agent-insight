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

import { inferSubagentNamesFromInteractions } from '@/lib/engine/observability/subagent-inference';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { db } from '@/lib/storage/prisma';

export interface AgentDebugExecutionRecord {
  id: string;
  taskId?: string | null;
  framework?: string | null;
  user?: string | null;
  query?: string | null;
  agentName?: string | null;
  finalResult?: string | null;
  skill?: string | null;
  skillVersion?: number | null;
  invokedSkills?: string | null;
  skills?: string | null;
}

interface SessionRecord {
  interactions?: string | unknown[] | null;
}

export async function resolveAgentDebugExecution(inputId: string): Promise<{ execution: AgentDebugExecutionRecord; interactions: unknown[] } | null> {
  const byId = await db.findExecutionById(inputId).catch(() => null) as AgentDebugExecutionRecord | null;
  let execution = byId;
  if (!execution) {
    const rows = await db.findExecutions({ taskId: inputId }, { timestamp: 'desc' }).catch(() => []) as AgentDebugExecutionRecord[];
    execution = rows[0] || null;
  }
  if (!execution?.id) return null;

  const sessionKey = execution.taskId || inputId;
  const session = await db.findSessionByTaskId(sessionKey).catch(() => null) as SessionRecord | null;
  let interactions = parseInteractions(session?.interactions);
  if (execution.framework === 'claudecode') {
    interactions = normalizeClaudeCodeInteractionsForStorage(interactions as Parameters<typeof normalizeClaudeCodeInteractionsForStorage>[0]);
  }
  interactions = inferSubagentNamesFromInteractions(interactions as Parameters<typeof inferSubagentNamesFromInteractions>[0]);
  return { execution, interactions };
}

function parseInteractions(value: SessionRecord['interactions']): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

