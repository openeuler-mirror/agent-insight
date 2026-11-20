/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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

import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { handleCoreReport } from '@/lib/storage-core/report-handlers';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const STOPPED_MESSAGE = 'AgentDebug Skills analysis background task stopped before completion. Please retry.';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  return handleCoreReport(_request, executionId, 'skills-analysis');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  return handleCoreReport(request, executionId, 'skills-analysis');
}

function summarizeSkillsAnalysisRow(
  row: Awaited<ReturnType<typeof findAgentDebugSkillsAnalysis>>,
  analysis?: AgentDebugSkillsAnalysis | null,
) {
  if (!row) return null;
  return {
    id: row.id,
    executionId: row.executionId,
    status: analysis?.status ?? row.status,
    errorMessage: analysis?.status === 'skipped' ? null : row.errorMessage,
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
