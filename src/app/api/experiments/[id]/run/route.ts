import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {coreExperimentWriteRoute,runCoreExperimentRoute} from '@/lib/storage-core/experiment-routes';
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

import { parseExecutionConcurrency } from '@/lib/engine/experiment/execution-concurrency';
// 触发实验执行：置 running + 逐行异步执行（fire-and-forget），立即返回当前状态。
// type='llm' 走对比执行；type='single' 可选生成 Trace/FI 后再走单组执行。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { startExperimentRun } from '@/lib/engine/experiment/run-experiment';
import {
  awaitFiSessionsAndBindExperimentCases,
  collectFiCasesFromExperiment,
  FiOrchestrateError,
  orchestrateFaultInjection,
} from '@/lib/engine/experiment/fi-orchestrate';
import {
  assertTraceGenerationTarget,
  collectTraceGenerationCases,
  generateExperimentTraces,
  TraceGenerationError,
} from '@/lib/engine/experiment/trace-generation';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { startComparisonRun } from '@/lib/engine/experiment/comparison-runner';
import { prisma } from '@/lib/storage/prisma';
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error';
import { startBenchmarkExperiment } from '@/lib/benchmark/scheduler';
import { defaultEvaluatorRuntimeConfigProvider } from '@/lib/benchmark/evaluator-runtime-config';
import { DEFAULT_EXPERIMENT_AGENT_TIMEOUT_SECONDS } from '@/lib/engine/experiment/constants';

export const dynamic = 'force-dynamic';

function callbackServiceBaseUrls(req: Request): {
  publicCallbackOrigin: string;
  executorCallbackOrigin: string;
} {
  const runtimeConfig = defaultEvaluatorRuntimeConfigProvider.snapshot();
  const url = new URL(req.url);
  const host = req.headers.get('x-forwarded-host') || url.host;
  const protocol = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const prefix = String(process.env.NEXT_PUBLIC_URL_PREFIX || '').replace(/^\/?/, '/').replace(/\/$/, '');
  const publicCallbackOrigin = `${protocol}://${host}${prefix}`;
  return {
    publicCallbackOrigin,
    executorCallbackOrigin: runtimeConfig.executorCallbackBaseUrl || publicCallbackOrigin,
  };
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
):Promise<Response> {
  {const {id}=await params;return coreExperimentWriteRoute(req,()=>runCoreExperimentRoute(id));}
}
