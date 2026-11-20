import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {coreExperimentWriteRoute,retryCoreExperimentCaseRoute} from '@/lib/storage-core/experiment-routes';
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

import type { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  awaitFiSessionsAndBindExperimentCases,
  orchestrateFaultInjection,
} from '@/lib/engine/experiment/fi-orchestrate';
import {
  retryResultRow,
  startEvalExperimentCases,
} from '@/lib/engine/experiment/run-experiment';
import {
  assertTraceGenerationTarget,
  generateExperimentTraces,
  loadTraceGenerationRetryRequest,
  reserveTraceRetry,
  TraceGenerationError,
} from '@/lib/engine/experiment/trace-generation';
import { prisma } from '@/lib/storage/prisma';
import { randomUUID } from 'node:crypto';
import { startBenchmarkExperiment } from '@/lib/benchmark/scheduler';
import { defaultEvaluatorRuntimeConfigProvider } from '@/lib/benchmark/evaluator-runtime-config';
import { DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS } from '@/lib/engine/experiment/constants';

export const dynamic = 'force-dynamic';

const CASE_RETRY_SET = Symbol.for('agent-insight.experiment-case-retry-set');

function retrySet(): Set<string> {
  const globalState = globalThis as typeof globalThis & { [CASE_RETRY_SET]?: Set<string> };
  if (!globalState[CASE_RETRY_SET]) globalState[CASE_RETRY_SET] = new Set<string>();
  return globalState[CASE_RETRY_SET];
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function settleAfterTraceRetryFailure(experimentId: string): Promise<void> {
  const completed = await prisma.experimentEvalResult.count({
    where: { experimentId, status: 'done' },
  });
  await prisma.experiment.updateMany({
    where: { id: experimentId },
    data: { status: completed > 0 ? 'partial' : 'failed' },
  });
}

async function prepareGeneratedTraceRetry(experimentId: string, caseId: string): Promise<void> {
  await prisma.$transaction([
    prisma.experimentCase.update({
      where: { id: caseId },
      data: {
        executionId: null,
        taskId: null,
        actualOutput: '',
        traceGenerationError: null,
      },
    }),
    prisma.experimentEvalResult.updateMany({
      where: { experimentId, caseId },
      data: {
        status: 'pending',
        verdict: null,
        summary: null,
        score: null,
        pointsJson: null,
        evidenceJson: null,
        errorMessage: null,
        attempts: { increment: 1 },
        durationMs: null,
        humanScore: null,
        humanReason: null,
        humanBy: null,
        humanAt: null,
      },
    }),
    prisma.experiment.update({ where: { id: experimentId }, data: { status: 'running' } }),
  ]);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> },
):Promise<Response> {
  {const {id,caseId}=await params;return coreExperimentWriteRoute(req,()=>retryCoreExperimentCaseRoute(id,caseId));}
}
