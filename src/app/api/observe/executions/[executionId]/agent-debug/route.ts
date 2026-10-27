import { createDiagnosisProgress, readDiagnosisProgress } from '@/lib/engine/agent-debug/progress-store';
import { NextRequest, NextResponse } from 'next/server';

import {
  clearActiveAgentDebugBackgroundJob,
  getActiveAgentDebugBackgroundJob,
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
    progress: progressForRow(row),
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
    return NextResponse.json({ report: existingPayload, row: summarizeRow(existing), cached: true, progress: progressForRow(existing) });
  }
  if (existing?.status === 'running' && existing.generator === AGENT_DEBUG_GENERATOR && existing.interactionsHash === interactionsHash) {
    if (hasActiveAgentDebugBackgroundJob('agent-debug', execution.id, interactionsHash)) {
      return NextResponse.json({ reportId: existing.id, row: summarizeRow(existing), status: 'running', progress: progressForRow(existing) }, { status: 409 });
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

  const progress = createDiagnosisProgress({ user, executionId: execution.id, runId: runningRow.id });
  progress.emit({ key: 'accepted', kind: 'task', state: 'started', title: '诊断请求已接收', summary: '等待诊断执行资源；获得资源后开始处理。' });

  setActiveAgentDebugBackgroundJob({
    progress,
    kind: 'agent-debug',
    executionId: execution.id,
    interactionsHash,
    startedAt: Date.now(),
  });

  void withBackgroundOpencodeSlot(
    () => {
      progress.emit({ key: 'started', kind: 'task', state: 'started', title: '诊断已开始', summary: '执行资源已就绪，正在准备诊断资料。' });
      return runAgentDebugDiagnosis({ execution, interactions, user, progress });
    },
    { taskType: 'agent-debug', user, label: `agent-debug: ${execution.id}` },
  )
    .then(async report => {
      await markAgentDebugReportDone({ executionId: execution.id, interactionsHash, report });
      progress.emit({ key: 'done', kind: 'task', state: report.skippedReason ? 'skipped' : 'completed', title: report.skippedReason ? '诊断未运行' : '诊断报告已归档', summary: report.skippedReason || '最终报告已返回，以下结论以最终报告为准。' });
    })
    .catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      progress.emit({ key: 'failed', kind: 'task', state: 'failed', title: '诊断中断', summary: '已保留获得的阶段内容；这些内容不能替代最终报告。' });
      return markAgentDebugReportFailed({ executionId: execution.id, interactionsHash, errorMessage: message });
    })
    .finally(() => clearActiveAgentDebugBackgroundJob('agent-debug', execution.id, interactionsHash));

  recordUsageEvent({ user, featureKey: 'trace', eventKey: 'trace.agent.debug' });

  return NextResponse.json({ reportId: runningRow.id, row: summarizeRow(runningRow), status: 'running', cached: false, progress: progress.snapshot() }, { status: 202 });
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

function progressForRow(row: Awaited<ReturnType<typeof findAgentDebugReport>>) {
  if (!row?.user) return null;
  const active = getActiveAgentDebugBackgroundJob('agent-debug', row.executionId)?.progress;
  if (active?.runId === row.id) return active.snapshot();
  return readDiagnosisProgress({ user: row.user, executionId: row.executionId, runId: row.id });
}
