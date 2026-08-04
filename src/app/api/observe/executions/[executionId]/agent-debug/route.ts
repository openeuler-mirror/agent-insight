import { NextRequest, NextResponse } from 'next/server';

import {
  clearActiveAgentDebugBackgroundJob,
  hasActiveAgentDebugBackgroundJob,
  setActiveAgentDebugBackgroundJob,
} from '@/lib/engine/agent-debug/background-jobs';
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
import { resolveAgentDebugExecution } from '@/lib/engine/agent-debug/execution-resolver';
import { withBackgroundOpencodeSlot } from '@/lib/engine/general-agent/concurrency-limiter';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const STOPPED_MESSAGE = 'AgentDebug background task stopped before completion. Please retry.';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  const resolved = await resolveAgentDebugExecution(executionId);
  if (!resolved) return NextResponse.json({ report: null, row: null });
  let row = await findAgentDebugReport(resolved.execution.id);
  if (
    row?.status === 'running'
    && row.generator === AGENT_DEBUG_GENERATOR
    && !hasActiveAgentDebugBackgroundJob('agent-debug', resolved.execution.id, row.interactionsHash)
  ) {
    row = await markAgentDebugReportFailed({
      executionId: resolved.execution.id,
      interactionsHash: row.interactionsHash,
      errorMessage: STOPPED_MESSAGE,
    });
  }
  const report = row?.status === 'done' ? parseReportPayload(row) : null;
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
  const resolved = await resolveAgentDebugExecution(executionId);
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
  if (existing?.status === 'running' && existing.generator === AGENT_DEBUG_GENERATOR && existing.interactionsHash === interactionsHash) {
    if (hasActiveAgentDebugBackgroundJob('agent-debug', execution.id, interactionsHash)) {
      return NextResponse.json({ reportId: existing.id, row: summarizeRow(existing), status: 'running' }, { status: 409 });
    }
    await markAgentDebugReportFailed({
      executionId: execution.id,
      interactionsHash,
      errorMessage: STOPPED_MESSAGE,
    });
  }

  const runningRow = await upsertRunningAgentDebugReport({
    executionId: execution.id,
    user,
    interactionsHash,
    generator: AGENT_DEBUG_GENERATOR,
  });

  setActiveAgentDebugBackgroundJob({
    kind: 'agent-debug',
    executionId: execution.id,
    interactionsHash,
    startedAt: Date.now(),
  });

  void withBackgroundOpencodeSlot(
    () => runAgentDebugDiagnosis({ execution, interactions, user }),
    { taskType: 'agent-debug', user, label: `agent-debug: ${execution.id}` },
  )
    .then(report => markAgentDebugReportDone({ executionId: execution.id, interactionsHash, report }))
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      return markAgentDebugReportFailed({ executionId: execution.id, interactionsHash, errorMessage: message });
    })
    .finally(() => clearActiveAgentDebugBackgroundJob('agent-debug', execution.id, interactionsHash));

  recordUsageEvent({ user, featureKey: 'trace', eventKey: 'trace.agent.debug' });

  return NextResponse.json({ reportId: runningRow.id, row: summarizeRow(runningRow), status: 'running', cached: false }, { status: 202 });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  const resolved = await resolveAgentDebugExecution(executionId);
  if (!resolved) return NextResponse.json({ ok: true });
  await deleteAgentDebugReport(resolved.execution.id);
  return NextResponse.json({ ok: true });
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
