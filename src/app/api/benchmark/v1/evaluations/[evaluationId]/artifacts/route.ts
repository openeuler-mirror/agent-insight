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
    let form: FormData
    try {
      form = await req.formData()
    } catch {
      throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_MULTIPART_INVALID', '证据请求不是合法 multipart', 400)
    }
    let metadata: Record<string, unknown>
    try {
      metadata = JSON.parse(String(form.get('metadata') || '{}')) as Record<string, unknown>
    } catch {
      throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_METADATA_INVALID', '证据 metadata 不是合法 JSON', 400)
    }
    if (metadata.evaluationId != null && metadata.evaluationId !== evaluationId) {
      throw new BenchmarkProtocolError('EVALUATION_ID_MISMATCH', '证据 evaluationId 与回调路径不一致', 422)
    }
    const file = form.get('file')
    if (!(file instanceof File)) {
      throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_FILE_MISSING', '证据请求缺少 file 字段', 400)
    }
    const result = await storeBenchmarkEvaluationArtifact({
      evaluationId,
      name: String(metadata.name || file.name || ''),
      kind: String(metadata.kind || ''),
      mediaType: String(metadata.mediaType || file.type || ''),
      expectedSha256: String(metadata.sha256 || ''),
      bytes: new Uint8Array(await file.arrayBuffer()),
    })
    return NextResponse.json(result, { status: 201 })
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/evaluations/artifacts')
  }
}
