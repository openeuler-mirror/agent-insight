import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'

import { resolveUser } from '@/lib/auth/auth'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { benchmarkArtifactAbsolutePath } from '@/lib/benchmark/evaluation-preparation-service'
import { readBenchmarkRunArtifact } from '@/lib/benchmark/experiment-result-service'
import { authenticateBenchmarkEvaluator } from '@/lib/benchmark/evaluator-target'
import { prisma } from '@/lib/storage/prisma'
import { BenchmarkProtocolError } from '../../../../../../../../packages/benchmark-protocol/src/errors'

export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ artifactId: string }> }) {
  try {
    const { artifactId } = await params
    const url = new URL(req.url)
    const { username } = await resolveUser(req, url.searchParams.get('user'))
    if (username) {
      const artifact = await readBenchmarkRunArtifact({ artifactId, user: username })
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
    }
    authenticateBenchmarkEvaluator(req)
    const evaluationId = req.headers.get('x-agent-insight-evaluation-id')?.trim()
    if (!evaluationId) {
      throw new BenchmarkProtocolError('EVALUATION_ID_MISSING', '缺少评测 Run 标识', 400)
    }
    const [artifact, evaluation] = await Promise.all([
      prisma.benchmarkArtifact.findUnique({ where: { id: artifactId } }),
      prisma.benchmarkEvaluation.findUnique({ where: { id: evaluationId } }),
    ])
    if (!artifact || !evaluation || artifact.runId !== evaluation.caseRunId) {
      throw new BenchmarkProtocolError('ARTIFACT_NOT_FOUND', 'Artifact 不存在或不属于当前评测', 404)
    }
    let request: { artifacts?: Array<{ artifactId?: string }> }
    try {
      request = JSON.parse(evaluation.requestJson) as typeof request
    } catch {
      throw new BenchmarkProtocolError('EVALUATION_JOB_INVALID', '评测任务快照损坏', 500)
    }
    if (!request.artifacts?.some((item) => item.artifactId === artifactId)) {
      throw new BenchmarkProtocolError('ARTIFACT_NOT_REFERENCED', '评测任务未引用该 Artifact', 403)
    }
    const bytes = await fs.readFile(benchmarkArtifactAbsolutePath(artifact.storagePath))
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (bytes.byteLength !== artifact.sizeBytes || digest !== artifact.sha256) {
      throw new BenchmarkProtocolError('ARTIFACT_CONTENT_MISMATCH', 'Artifact 内容完整性校验失败', 409)
    }
    return new Response(new Blob([bytes]), {
      status: 200,
      headers: {
        'content-type': artifact.mediaType,
        'content-length': String(bytes.byteLength),
        'content-disposition': `attachment; filename="${artifact.name}"`,
        etag: `"${artifact.sha256}"`,
        'cache-control': 'private, no-store',
      },
    })
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/artifacts/content')
  }
}
