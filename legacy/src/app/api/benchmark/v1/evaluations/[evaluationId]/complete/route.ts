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

import { NextResponse } from 'next/server'

import type { BenchmarkEvaluationCompletion } from '../../../../../../../../packages/benchmark-protocol/src/evaluator-contracts'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { completeBenchmarkEvaluation } from '@/lib/benchmark/evaluation-callback-service'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ evaluationId: string }> },
) {
  try {
    const { evaluationId } = await params
    const completion = await req.json() as BenchmarkEvaluationCompletion
    return NextResponse.json(await completeBenchmarkEvaluation({ evaluationId, completion }))
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/evaluations/complete')
  }
}
