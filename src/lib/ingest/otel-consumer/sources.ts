import type { ExecutionRecord } from '@/lib/storage/data-service';
import { aggregateClaudeOtelSession } from '@/lib/ingest/claude-otel/aggregator';
import { aggregateOtelTraceSession } from '@/lib/ingest/otel/aggregate';
import {
  getClaudeOtelSpoolDir,
  listClaudeOtelSpoolFiles,
} from '@/lib/ingest/claude-otel/spool';
import { getOtelTraceSpoolDir, listOtelTraceSpoolFiles } from '@/lib/ingest/otel/spool';

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
