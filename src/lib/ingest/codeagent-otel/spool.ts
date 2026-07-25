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
