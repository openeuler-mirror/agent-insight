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

import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { EvaluatorSkillError } from '../evaluators/evaluator-skill-store'

export function benchmarkErrorResponse(error: unknown, source: string): NextResponse {
  if (error instanceof EvaluatorSkillError) {
    return NextResponse.json(
      { error: { code: 'EVALUATOR_SKILL_ERROR', message: error.message, retryable: false } },
      { status: error.status },
    )
  }
  if (error instanceof BenchmarkProtocolError) {
    return NextResponse.json(
      {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          ...(error.details ? { details: error.details } : {}),
        },
      },
      { status: error.httpStatus },
    )
  }
  console.error(`[${source}]`, error)
  return NextResponse.json(
    { error: { code: 'INTERNAL_ERROR', message: 'Benchmark 服务内部错误', retryable: false } },
    { status: 500 },
  )
}
