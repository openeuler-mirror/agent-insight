import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import { getBenchmarkAdapter } from '@/lib/benchmark/adapter-registry'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { benchmarkDatasetOwners } from '@/lib/benchmark/dataset-ownership'
import { listBenchmarkExecutionTargets } from '@/lib/benchmark/execution-targets'
import { prisma } from '@/lib/storage/prisma'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const { username } = await resolveUser(req, url.searchParams.get('user'))
  if (!username) {
    return NextResponse.json(
      { error: { code: 'USER_REQUIRED', message: '缺少用户身份' } },
      { status: 401 },
    )
  }

  try {
    const datasetId = String(url.searchParams.get('datasetId') || '').trim()
    let adapterKey = 'swe-bench'
    if (datasetId) {
      const dataset = await prisma.benchmarkDataset.findFirst({
        where: { id: datasetId, user: { in: benchmarkDatasetOwners(username) }, status: 'ready' },
        select: { adapterKey: true },
      })
      if (!dataset) {
        return NextResponse.json(
          { error: { code: 'BENCHMARK_DATASET_NOT_FOUND', message: 'Benchmark 数据集不存在或未就绪' } },
          { status: 404 },
        )
      }
      adapterKey = dataset.adapterKey
    }

    const manifest = getBenchmarkAdapter(adapterKey).manifest
    const items = await listBenchmarkExecutionTargets(username, manifest)
    return NextResponse.json({ items })
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/execution-targets')
  }
}
