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
import { resolveAgentDebugExecution } from '@/lib/engine/agent-debug/execution-resolver';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  const resolved = await resolveAgentDebugExecution(executionId);
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
  const savedSkillsAnalysis = existing?.interactionsHash === interactionsHash
    ? existingPayload?.skillsAnalysis || null
    : null;
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
    const report = await runAgentDebugDiagnosis({ execution, interactions, user, skillsAnalysis: savedSkillsAnalysis });
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
