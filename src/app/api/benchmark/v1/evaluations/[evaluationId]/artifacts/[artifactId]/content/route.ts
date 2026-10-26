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

import { resolveUser } from '@/lib/auth/auth'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { readBenchmarkEvaluationArtifact } from '@/lib/benchmark/experiment-result-service'
import { BenchmarkProtocolError } from '../../../../../../../../../../packages/benchmark-protocol/src/errors'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  { params }: { params: Promise<{ evaluationId: string; artifactId: string }> },
) {
  try {
    const { evaluationId, artifactId } = await params
    const url = new URL(req.url)
    const { username } = await resolveUser(req, url.searchParams.get('user'))
    if (!username) {
      throw new BenchmarkProtocolError('USER_REQUIRED', '缺少用户身份', 401)
    }
    const artifact = await readBenchmarkEvaluationArtifact({ evaluationId, artifactId, user: username })
    return new Response(new Blob([new Uint8Array(artifact.bytes)]), {
      status: 200,
      headers: {
        'content-type': artifact.mediaType,
        'content-length': String(artifact.bytes.byteLength),
        'content-disposition': `attachment; filename="${artifact.name}"`,
        etag: `"${artifact.sha256}"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/evaluations/artifacts/content')
  }
}
