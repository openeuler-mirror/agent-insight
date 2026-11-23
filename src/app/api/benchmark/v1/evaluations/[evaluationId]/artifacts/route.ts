import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
import {coreBenchmarkCallbackContext,coreBenchmarkCallbackArtifact} from '@/lib/benchmark/core-public-callback'
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

import { BenchmarkProtocolError } from '../../../../../../../../packages/benchmark-protocol/src/errors'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { storeBenchmarkEvaluationArtifact } from '@/lib/benchmark/evaluation-callback-service'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ evaluationId: string }> },
) {
  try {
    const { evaluationId } = await params
    return NextResponse.json(await coreBenchmarkCallbackArtifact(req,coreBenchmarkCallbackContext(req),evaluationId),{status:201})
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/evaluations/artifacts')
  }
}
