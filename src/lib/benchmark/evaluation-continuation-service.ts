import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
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

import { prisma } from '@/lib/storage/prisma'

const CONTINUATION_LEASE_MS = 30_000
const scheduledContinuations = new Set<Promise<void>>()
const continuationTimers = new Set<ReturnType<typeof setTimeout>>()

export async function waitForBenchmarkEvaluationContinuationsForTest(): Promise<void> {
  while (scheduledContinuations.size) {
    for (const timer of continuationTimers) timer.ref?.()
    await Promise.allSettled([...scheduledContinuations])
  }
}

const TERMINAL_EVALUATION_STATUSES = [
  'completed',
  'failed',
  'submission_invalid',
  'normalization_failed',
  'dispatch_failed',
]

export async function runBenchmarkEvaluationContinuation(evaluationId: string): Promise<boolean> {
  throw Object.assign(new Error('Typed Benchmark continuation required'),{status:503})
}

export function scheduleBenchmarkEvaluationContinuation(evaluationId: string): void {
  throw Object.assign(new Error('Typed Benchmark continuation required'),{status:503})
}

export async function resumeBenchmarkEvaluationContinuations(limit = 100): Promise<number> {
  return 0
}
