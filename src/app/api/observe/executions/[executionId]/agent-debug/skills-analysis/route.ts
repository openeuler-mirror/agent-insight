import { randomUUID } from 'node:crypto';
import { createDiagnosisProgress, readDiagnosisProgress } from '@/lib/engine/agent-debug/progress-store';
import type { AgentDebugSkillsAnalysis } from '@/lib/engine/agent-debug/types';
import { NextRequest, NextResponse } from 'next/server';

import {
  clearActiveAgentDebugBackgroundJob,
  getActiveAgentDebugBackgroundJob,
  hasActiveAgentDebugBackgroundJob,
  setActiveAgentDebugBackgroundJob,
} from '@/lib/engine/agent-debug/background-jobs';
import { resolveAgentDebugExecution } from '@/lib/engine/agent-debug/execution-resolver';
import {
  findAgentDebugSkillsAnalysis,
  parseSkillsAnalysisPayload,
  updateRunningAgentDebugSkillsAnalysis,
  upsertAgentDebugSkillsAnalysis,
} from '@/lib/engine/agent-debug/report-store';
import {
  failedAgentDebugSkillsAnalysis,
  runAgentDebugSkillsAnalysis,
  runningAgentDebugSkillsAnalysis,
} from '@/lib/engine/agent-debug/skills-analysis';
import { hashInteractions } from '@/lib/engine/agent-debug/trace-adapter';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const STOPPED_MESSAGE = 'AgentDebug Skills analysis background task stopped before completion. Please retry.';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  const resolved = await resolveAgentDebugExecution(executionId);
  if (!resolved) return NextResponse.json({ row: null, skillsAnalysis: null });

  const { execution, interactions } = resolved;
  const interactionHash = hashInteractions(interactions);
  let row = await findAgentDebugSkillsAnalysis(execution.id);
  if (
    row?.status === 'running'
    && row.interactionsHash === interactionHash
    && !hasActiveAgentDebugBackgroundJob('skills-analysis', execution.id, interactionHash)
  ) {
    row = await updateRunningAgentDebugSkillsAnalysis({
      executionId: execution.id,
      user: row.user,
      interactionsHash: interactionHash,
      skillsAnalysis: { ...failedAgentDebugSkillsAnalysis({
        interactionHash,
        errorMessage: STOPPED_MESSAGE,
      }), runId: parseSkillsAnalysisPayload(row)?.runId },
    });
  }
  const skillsAnalysis = row?.interactionsHash === interactionHash
    ? parseSkillsAnalysisPayload(row)
    : null;

  return NextResponse.json({
    row: summarizeSkillsAnalysisRow(row),
    skillsAnalysis: withProgress(skillsAnalysis, row),
    stale: Boolean(row && row.interactionsHash !== interactionHash),
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

  const interactionHash = hashInteractions(interactions);
  const row = await findAgentDebugSkillsAnalysis(execution.id);
  const cached = row?.interactionsHash === interactionHash
    ? parseSkillsAnalysisPayload(row)
    : null;
  if (cached?.status === 'running' && cached.interactionHash === interactionHash) {
    if (!hasActiveAgentDebugBackgroundJob('skills-analysis', execution.id, interactionHash)) {
      await updateRunningAgentDebugSkillsAnalysis({
        executionId: execution.id,
        user,
        interactionsHash: interactionHash,
        skillsAnalysis: { ...failedAgentDebugSkillsAnalysis({
          interactionHash,
          errorMessage: STOPPED_MESSAGE,
        }), runId: cached.runId },
      });
    } else {
      return NextResponse.json(
        { row: summarizeSkillsAnalysisRow(row), skillsAnalysis: withProgress(cached, row), status: 'running' },
        { status: 409 },
      );
    }
  }
  if (
    !body.force
    && cached?.status === 'done'
    && cached.interactionHash === interactionHash
    && Array.isArray(cached.keyActionResults)
    && cached.keyActionResults.length > 0
  ) {
    return NextResponse.json({ row: summarizeSkillsAnalysisRow(row), skillsAnalysis: withProgress(cached, row), cached: true });
  }

  const runId = randomUUID();
  const runningAnalysis = { ...runningAgentDebugSkillsAnalysis({ interactionHash }), runId };
  const progress = createDiagnosisProgress({ user, executionId: execution.id, runId });
  progress.emit({ key: 'accepted', kind: 'task', module: 'skills', state: 'started', title: 'Skills 核验已开始', summary: '独立核验任务已创建。' });
  const runningRow = await upsertAgentDebugSkillsAnalysis({
    executionId: execution.id,
    user,
    interactionsHash: interactionHash,
    skillsAnalysis: runningAnalysis,
  });

  setActiveAgentDebugBackgroundJob({
    progress,
    kind: 'skills-analysis',
    executionId: execution.id,
    interactionsHash: interactionHash,
    startedAt: Date.now(),
  });

  void runAgentDebugSkillsAnalysis({
      execution,
      interactions,
      user,
      interactionHash,
      progress,
    })
    .then(skillsAnalysis => updateRunningAgentDebugSkillsAnalysis({
      executionId: execution.id,
      user,
      interactionsHash: interactionHash,
      skillsAnalysis: { ...skillsAnalysis, runId },
    }))
    .catch(error => {
      progress.emit({ key: 'failed', kind: 'task', module: 'skills', state: 'failed', title: 'Skills 核验中断', summary: '已返回的阶段内容仍可查看。' });
      const message = error instanceof Error ? error.message : String(error);
      return updateRunningAgentDebugSkillsAnalysis({
        executionId: execution.id,
        user,
        interactionsHash: interactionHash,
        skillsAnalysis: { ...failedAgentDebugSkillsAnalysis({
          interactionHash,
          errorMessage: message,
        }), runId },
      });
    })
    .finally(() => clearActiveAgentDebugBackgroundJob('skills-analysis', execution.id, interactionHash));

  return NextResponse.json({
    row: summarizeSkillsAnalysisRow(runningRow),
    skillsAnalysis: { ...runningAnalysis, progress: progress.snapshot() },
    status: 'running',
    cached: false,
  }, { status: 202 });
}

function summarizeSkillsAnalysisRow(row: Awaited<ReturnType<typeof findAgentDebugSkillsAnalysis>>) {
  if (!row) return null;
  return {
    id: row.id,
    executionId: row.executionId,
    status: row.status,
    errorMessage: row.errorMessage,
    interactionsHash: row.interactionsHash,
    keyActionCount: row.keyActionCount,
    ranAt: row.ranAt,
    updatedAt: row.updatedAt,
  };
}

function withProgress(analysis: AgentDebugSkillsAnalysis | null, row: Awaited<ReturnType<typeof findAgentDebugSkillsAnalysis>>) {
  if (!analysis?.runId || !row?.user) return analysis;
  const active = getActiveAgentDebugBackgroundJob('skills-analysis', row.executionId)?.progress;
  const progress = active?.runId === analysis.runId ? active.snapshot()
    : readDiagnosisProgress({ user: row.user, executionId: row.executionId, runId: analysis.runId });
  return { ...analysis, progress };
}
