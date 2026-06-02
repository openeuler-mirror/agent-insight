import { NextRequest, NextResponse } from 'next/server';

import { runAgentDebugDiagnosis } from '@/lib/engine/agent-debug/runner';
import { AGENT_DEBUG_GENERATOR } from '@/lib/engine/agent-debug/runner';
import {
  deleteAgentDebugReport,
  findAgentDebugReport,
  markAgentDebugReportDone,
  markAgentDebugReportFailed,
  parseReportPayload,
  upsertRunningAgentDebugReport,
} from '@/lib/engine/agent-debug/report-store';
import { hashInteractions } from '@/lib/engine/agent-debug/trace-adapter';
import { inferSubagentNamesFromInteractions } from '@/lib/engine/observability/subagent-inference';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { db } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

interface ExecutionRecord {
  id: string;
  taskId?: string | null;
  framework?: string | null;
  failures?: string | null;
  answerScore?: number | null;
  judgmentReason?: string | null;
  user?: string | null;
  query?: string | null;
}

interface SessionRecord {
  interactions?: string | unknown[] | null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  const resolved = await resolveExecution(executionId);
  if (!resolved) return NextResponse.json({ report: null, row: null });
  const row = await findAgentDebugReport(resolved.execution.id);
  const report = row?.generator === AGENT_DEBUG_GENERATOR ? parseReportPayload(row) : null;
  return NextResponse.json({
    report,
    row: summarizeRow(row),
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  const body = await request.json().catch(() => ({})) as { user?: string; force?: boolean };
  const resolved = await resolveExecution(executionId);
  if (!resolved) {
    return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
  }

  const { execution, interactions } = resolved;
  const user = String(body.user || execution.user || '').trim();
  if (!user) {
    return NextResponse.json({ error: 'user is required' }, { status: 400 });
  }
  const interactionsHash = hashInteractions(interactions);
  const existing = await findAgentDebugReport(execution.id);
  const existingPayload = parseReportPayload(existing);
  if (!body.force && existing?.status === 'done' && existing.generator === AGENT_DEBUG_GENERATOR && existing.interactionsHash === interactionsHash && existingPayload) {
    return NextResponse.json({ report: existingPayload, row: summarizeRow(existing), cached: true });
  }
  if (!body.force && existing?.status === 'running' && existing.generator === AGENT_DEBUG_GENERATOR && existing.interactionsHash === interactionsHash) {
    return NextResponse.json({ reportId: existing.id, status: 'running' }, { status: 409 });
  }

  await upsertRunningAgentDebugReport({
    executionId: execution.id,
    user,
    interactionsHash,
  });

  try {
    const report = await runAgentDebugDiagnosis({ execution, interactions, user });
    const row = await markAgentDebugReportDone({ executionId: execution.id, report });
    return NextResponse.json({ report, row: summarizeRow(row), cached: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const row = await markAgentDebugReportFailed({ executionId: execution.id, errorMessage: message });
    return NextResponse.json({ error: message, row: summarizeRow(row) }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  const resolved = await resolveExecution(executionId);
  if (!resolved) return NextResponse.json({ ok: true });
  await deleteAgentDebugReport(resolved.execution.id);
  return NextResponse.json({ ok: true });
}

async function resolveExecution(inputId: string): Promise<{ execution: ExecutionRecord; interactions: unknown[] } | null> {
  const byId = await db.findExecutionById(inputId).catch(() => null) as ExecutionRecord | null;
  let execution = byId;
  if (!execution) {
    const rows = await db.findExecutions({ taskId: inputId }, { timestamp: 'desc' }).catch(() => []) as ExecutionRecord[];
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

function summarizeRow(row: Awaited<ReturnType<typeof findAgentDebugReport>>) {
  if (!row) return null;
  return {
    id: row.id,
    executionId: row.executionId,
    status: row.status,
    errorMessage: row.errorMessage,
    interactionsHash: row.interactionsHash,
    stepCount: row.stepCount,
    issueCount: row.issueCount,
    llmCallCount: row.llmCallCount,
    durationMs: row.durationMs,
    generator: row.generator,
    ranAt: row.ranAt,
    updatedAt: row.updatedAt,
  };
}
