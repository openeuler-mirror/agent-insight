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
