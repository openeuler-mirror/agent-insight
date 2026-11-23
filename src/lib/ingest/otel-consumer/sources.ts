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

import type { ExecutionRecord } from '@/lib/storage/data-service';
import { aggregateClaudeOtelSession } from '@/lib/ingest/claude-otel/aggregator';
import { aggregateCodeAgentOtelSession } from '@/lib/ingest/codeagent-otel/aggregator';
import { aggregateOtelTraceSession } from '@/lib/ingest/otel/aggregate';
import { aggregateDeepSeekHarnessOtelSession } from '@/lib/ingest/deepseek-harness-otel/aggregator';
import {
  getClaudeOtelSpoolDir,
  listClaudeOtelSpoolFiles,
  listClaudeOtelSpoolFilesForDay,
  listOtelTraceSpoolFilesForDay,
  statSessionSpool,
} from '@/lib/ingest/claude-otel/spool';
import {
  getCodeAgentOtelSpoolDir,
  listCodeAgentOtelSpoolFiles,
} from '@/lib/ingest/codeagent-otel/spool';
import {
  getActrailOtelTraceSpoolDir,
  getOtelTraceSpoolDir,
  listOtelTraceSpoolFiles,
} from '@/lib/ingest/otel/spool';
import {
  getDeepSeekHarnessOtelSpoolDir,
  listDeepSeekHarnessOtelSpoolFiles,
  listDeepSeekHarnessOtelSpoolFilesForDay,
} from '@/lib/ingest/deepseek-harness-otel/spool';

export type SpoolAggregationResult =
  | {
    sessionId: string;
    record: ExecutionRecord;
    eventCount: number;
    disposition: 'persisted';
  }
  | {
    sessionId: string;
    record: null;
    eventCount: number;
    disposition: 'retry-later' | 'discard';
  };

export type SpoolSource = {
  id: string;
  spoolDir: () => string;
  fileName?: 'logs.jsonl' | 'traces.jsonl' | 'events.jsonl';
  listFiles: () => string[];
  /** 只列某一天的文件。有它才能做"当天每 tick 扫、历史低频扫"的分层发现。 */
  listFilesForDay?: (day: string) => string[];
  aggregate: (sessionId: string) => SpoolAggregationResult;
  /** 该 session 落盘状态的指纹;两次相同说明没有新数据,聚合结果可复用。 */
  statSession?: (sessionId: string) => string;
  defaultSkipEvaluation: () => boolean;
};

function defaultSkipEvaluation(): boolean {
  return process.env.AGENT_INSIGHT_CLAUDE_OTEL_SKIP_EVALUATION !== 'false';
}

function codeAgentDefaultSkipEvaluation(): boolean {
  return process.env.AGENT_INSIGHT_CODEAGENT_OTEL_SKIP_EVALUATION !== 'false';
}

export function listSources(): SpoolSource[] {
  return [
    {
      id: 'deepseek-harness-otel-logs',
      fileName: 'events.jsonl',
      spoolDir: getDeepSeekHarnessOtelSpoolDir,
      listFiles: () => listDeepSeekHarnessOtelSpoolFiles(getDeepSeekHarnessOtelSpoolDir()),
      listFilesForDay: (day) => listDeepSeekHarnessOtelSpoolFilesForDay(day, getDeepSeekHarnessOtelSpoolDir()),
      aggregate: aggregateDeepSeekHarnessOtelSession,
      statSession: (sessionId) => statSessionSpool(getDeepSeekHarnessOtelSpoolDir(), 'events.jsonl', sessionId),
      defaultSkipEvaluation: () => true,
    },
    {
      id: 'codeagent-otel-logs',
      fileName: 'logs.jsonl',
      spoolDir: getCodeAgentOtelSpoolDir,
      listFiles: () => listCodeAgentOtelSpoolFiles(getCodeAgentOtelSpoolDir()),
      listFilesForDay: (day) => listClaudeOtelSpoolFilesForDay(day, getCodeAgentOtelSpoolDir()),
      aggregate: aggregateCodeAgentOtelSession,
      statSession: (sessionId) => statSessionSpool(getCodeAgentOtelSpoolDir(), 'logs.jsonl', sessionId),
      defaultSkipEvaluation: codeAgentDefaultSkipEvaluation,
    },
    {
      id: 'claude-otel-logs',
      fileName: 'logs.jsonl',
      spoolDir: getClaudeOtelSpoolDir,
      listFiles: () => listClaudeOtelSpoolFiles(getClaudeOtelSpoolDir()),
      listFilesForDay: (day) => listClaudeOtelSpoolFilesForDay(day, getClaudeOtelSpoolDir()),
      aggregate: aggregateClaudeOtelSession,
      statSession: (sessionId) => statSessionSpool(getClaudeOtelSpoolDir(), 'logs.jsonl', sessionId),
      defaultSkipEvaluation,
    },
    {
      id: 'actrail-otel-traces',
      fileName: 'traces.jsonl',
      spoolDir: getActrailOtelTraceSpoolDir,
      listFiles: () => listOtelTraceSpoolFiles(getActrailOtelTraceSpoolDir()),
      listFilesForDay: (day) => listOtelTraceSpoolFilesForDay(day, getActrailOtelTraceSpoolDir()),
      aggregate: (sessionId) => aggregateOtelTraceSession(sessionId, getActrailOtelTraceSpoolDir()),
      statSession: (sessionId) => statSessionSpool(getActrailOtelTraceSpoolDir(), 'traces.jsonl', sessionId),
      defaultSkipEvaluation: () => true,
    },
    {
      id: 'otel-traces',
      fileName: 'traces.jsonl',
      spoolDir: getOtelTraceSpoolDir,
      listFiles: () => listOtelTraceSpoolFiles(getOtelTraceSpoolDir()),
      listFilesForDay: (day) => listOtelTraceSpoolFilesForDay(day, getOtelTraceSpoolDir()),
      aggregate: (sessionId) => aggregateOtelTraceSession(sessionId, getOtelTraceSpoolDir()),
      statSession: (sessionId) => statSessionSpool(getOtelTraceSpoolDir(), 'traces.jsonl', sessionId),
      defaultSkipEvaluation: () => true,
    },
  ];
}
