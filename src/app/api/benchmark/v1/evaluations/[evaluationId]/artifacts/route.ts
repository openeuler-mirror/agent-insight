import { NextResponse } from 'next/server'

import { BenchmarkProtocolError } from '../../../../../../../../packages/benchmark-protocol/src/errors'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { storeBenchmarkEvaluationArtifact } from '@/lib/benchmark/evaluation-callback-service'
import { authenticateBenchmarkEvaluator } from '@/lib/benchmark/evaluator-target'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ evaluationId: string }> },
) {
  try {
    authenticateBenchmarkEvaluator(req)
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
