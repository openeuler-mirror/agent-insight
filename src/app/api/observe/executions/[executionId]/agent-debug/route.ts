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

import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { handleCoreReport } from '@/lib/storage-core/report-handlers';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const STOPPED_MESSAGE = 'AgentDebug background task stopped before completion. Please retry.';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  return handleCoreReport(_request, executionId, 'agent-debug');
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  return handleCoreReport(request, executionId, 'agent-debug');
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ executionId: string }> },
) {
  const { executionId } = await params;
  return handleCoreReport(_request, executionId, 'agent-debug');
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
