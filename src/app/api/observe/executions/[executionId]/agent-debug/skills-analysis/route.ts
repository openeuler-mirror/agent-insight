import { NextRequest, NextResponse } from 'next/server';

import { resolveAgentDebugExecution } from '@/lib/engine/agent-debug/execution-resolver';
import {
  findAgentDebugReport,
  parseReportPayload,
  updateAgentDebugSkillsAnalysis,
} from '@/lib/engine/agent-debug/report-store';
import {
  failedAgentDebugSkillsAnalysis,
  runAgentDebugSkillsAnalysis,
  runningAgentDebugSkillsAnalysis,
} from '@/lib/engine/agent-debug/skills-analysis';
import { hashInteractions } from '@/lib/engine/agent-debug/trace-adapter';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

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

  const row = await findAgentDebugReport(execution.id);
  const report = parseReportPayload(row);
  if (!row || !report) {
    return NextResponse.json(
      { error: 'AgentDebug report is required before generating Skills analysis' },
      { status: 404 },
    );
  }

  const interactionHash = hashInteractions(interactions);
  const cached = report.skillsAnalysis;
  if (cached?.status === 'running' && cached.interactionHash === interactionHash) {
    return NextResponse.json(
      { report, row, skillsAnalysis: cached, status: 'running' },
      { status: 409 },
    );
  }
  if (
    !body.force
    && cached?.status === 'done'
    && cached.interactionHash === interactionHash
    && Array.isArray(cached.keyActionResults)
    && cached.keyActionResults.length > 0
  ) {
    return NextResponse.json({ report, row, skillsAnalysis: cached, cached: true });
  }

  await updateAgentDebugSkillsAnalysis({
    executionId: execution.id,
    skillsAnalysis: runningAgentDebugSkillsAnalysis({ interactionHash }),
  });

  try {
    const skillsAnalysis = await runAgentDebugSkillsAnalysis({
      execution,
      interactions,
      user,
      interactionHash,
    });
    const updatedRow = await updateAgentDebugSkillsAnalysis({
      executionId: execution.id,
      skillsAnalysis,
    });
    const updatedReport = parseReportPayload(updatedRow);
    return NextResponse.json({
      report: updatedReport,
      row: updatedRow,
      skillsAnalysis,
      cached: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const skillsAnalysis = failedAgentDebugSkillsAnalysis({
      interactionHash,
      errorMessage: message,
    });
    const updatedRow = await updateAgentDebugSkillsAnalysis({
      executionId: execution.id,
      skillsAnalysis,
    });
    const updatedReport = parseReportPayload(updatedRow);
    return NextResponse.json(
      {
        error: message,
        report: updatedReport,
        row: updatedRow,
        skillsAnalysis,
      },
      { status: 500 },
    );
  }
}
