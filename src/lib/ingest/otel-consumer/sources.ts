import type { ExecutionRecord } from '@/lib/storage/data-service';
import { aggregateClaudeOtelSession } from '@/lib/ingest/claude-otel/aggregator';
import { aggregateCodeAgentOtelSession } from '@/lib/ingest/codeagent-otel/aggregator';
import { aggregateOtelTraceSession } from '@/lib/ingest/otel/aggregate';
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

export type SpoolAggregationResult = {
  sessionId: string;
  record: ExecutionRecord | null;
  eventCount: number;
};

export type SpoolSource = {
  id: string;
  spoolDir: () => string;
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
      id: 'codeagent-otel-logs',
      spoolDir: getCodeAgentOtelSpoolDir,
      listFiles: () => listCodeAgentOtelSpoolFiles(getCodeAgentOtelSpoolDir()),
      listFilesForDay: (day) => listClaudeOtelSpoolFilesForDay(day, getCodeAgentOtelSpoolDir()),
      aggregate: aggregateCodeAgentOtelSession,
      statSession: (sessionId) => statSessionSpool(getCodeAgentOtelSpoolDir(), 'logs.jsonl', sessionId),
      defaultSkipEvaluation: codeAgentDefaultSkipEvaluation,
    },
    {
      id: 'claude-otel-logs',
      spoolDir: getClaudeOtelSpoolDir,
      listFiles: () => listClaudeOtelSpoolFiles(getClaudeOtelSpoolDir()),
      listFilesForDay: (day) => listClaudeOtelSpoolFilesForDay(day, getClaudeOtelSpoolDir()),
      aggregate: aggregateClaudeOtelSession,
      statSession: (sessionId) => statSessionSpool(getClaudeOtelSpoolDir(), 'logs.jsonl', sessionId),
      defaultSkipEvaluation,
    },
    {
      id: 'actrail-otel-traces',
      spoolDir: getActrailOtelTraceSpoolDir,
      listFiles: () => listOtelTraceSpoolFiles(getActrailOtelTraceSpoolDir()),
      listFilesForDay: (day) => listOtelTraceSpoolFilesForDay(day, getActrailOtelTraceSpoolDir()),
      aggregate: (sessionId) => aggregateOtelTraceSession(sessionId, getActrailOtelTraceSpoolDir()),
      statSession: (sessionId) => statSessionSpool(getActrailOtelTraceSpoolDir(), 'traces.jsonl', sessionId),
      defaultSkipEvaluation: () => true,
    },
    {
      id: 'otel-traces',
      spoolDir: getOtelTraceSpoolDir,
      listFiles: () => listOtelTraceSpoolFiles(getOtelTraceSpoolDir()),
      listFilesForDay: (day) => listOtelTraceSpoolFilesForDay(day, getOtelTraceSpoolDir()),
      aggregate: (sessionId) => aggregateOtelTraceSession(sessionId, getOtelTraceSpoolDir()),
      statSession: (sessionId) => statSessionSpool(getOtelTraceSpoolDir(), 'traces.jsonl', sessionId),
      defaultSkipEvaluation: () => true,
    },
  ];
}
