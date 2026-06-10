import type { ExecutionRecord } from '@/lib/storage/data-service';
import { aggregateClaudeOtelSession } from '@/lib/ingest/claude-otel/aggregator';
import { aggregateOtelTraceSession } from '@/lib/ingest/claude-otel/traces-aggregator';
import {
  getClaudeOtelSpoolDir,
  getOtelTraceSpoolDir,
  listClaudeOtelSpoolFiles,
  listOtelTraceSpoolFiles,
} from '@/lib/ingest/claude-otel/spool';

export type SpoolAggregationResult = {
  sessionId: string;
  record: ExecutionRecord | null;
  eventCount: number;
};

export type SpoolSource = {
  id: string;
  spoolDir: () => string;
  listFiles: () => string[];
  aggregate: (sessionId: string) => SpoolAggregationResult;
  defaultSkipEvaluation: () => boolean;
};

function defaultSkipEvaluation(): boolean {
  return process.env.AGENT_INSIGHT_CLAUDE_OTEL_SKIP_EVALUATION !== 'false';
}

export function listSources(): SpoolSource[] {
  return [
    {
      id: 'claude-otel-logs',
      spoolDir: getClaudeOtelSpoolDir,
      listFiles: () => listClaudeOtelSpoolFiles(getClaudeOtelSpoolDir()),
      aggregate: aggregateClaudeOtelSession,
      defaultSkipEvaluation,
    },
    {
      id: 'otel-traces',
      spoolDir: getOtelTraceSpoolDir,
      listFiles: () => listOtelTraceSpoolFiles(getOtelTraceSpoolDir()),
      aggregate: (sessionId) => aggregateOtelTraceSession(sessionId, getOtelTraceSpoolDir()),
      defaultSkipEvaluation: () => true,
    },
  ];
}
