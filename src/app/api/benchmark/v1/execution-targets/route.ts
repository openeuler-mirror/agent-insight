import { NextResponse } from 'next/server'

import { resolveUser } from '@/lib/auth/auth'
import { getBenchmarkAdapter } from '@/lib/benchmark/adapter-registry'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { benchmarkDatasetOwners } from '@/lib/benchmark/dataset-ownership'
import { listBenchmarkExecutionTargets } from '@/lib/benchmark/execution-targets'
import { getBenchmarkExecutorConfig, saveBenchmarkExecutorConfig } from '@/lib/benchmark/executor-config'
import { BenchmarkProtocolError } from '../../../../../../packages/benchmark-protocol/src/errors'
import { prisma } from '@/lib/storage/prisma'

export const dynamic = 'force-dynamic'

async function findDataset(username: string, datasetId: string) {
  if (!datasetId) throw new BenchmarkProtocolError('BENCHMARK_DATASET_REQUIRED', '缺少 Benchmark 数据集', 400)
  const dataset = await prisma.benchmarkDataset.findFirst({
    where: {
      OR: [{ id: datasetId }, { agentEvalDatasetId: datasetId }],
      user: { in: benchmarkDatasetOwners(username) }, status: 'ready',
    },
    select: { adapterKey: true },
  })
  if (!dataset) throw new BenchmarkProtocolError('BENCHMARK_DATASET_NOT_FOUND', 'Benchmark 数据集不存在或未就绪', 404)
  return dataset
}

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
    const dataset = await findDataset(username, datasetId)

    const manifest = getBenchmarkAdapter(dataset.adapterKey).manifest
    const items = await listBenchmarkExecutionTargets(username, manifest)
    const configuredItems = await Promise.all(items.map(async item => ({
      ...item,
      benchmarkConfig: dataset.adapterKey === 'zsoft-l1'
        ? await getBenchmarkExecutorConfig(username, item.clientId, dataset.adapterKey) : null,
    })))
    return NextResponse.json({ benchmarkKey: dataset.adapterKey, items: configuredItems })
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/execution-targets')
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json()
    const { username } = await resolveUser(req, body.user)
    if (!username) return NextResponse.json({ error: { code: 'USER_REQUIRED', message: '缺少用户身份' } }, { status: 401 })
    const dataset = await findDataset(username, String(body.datasetId || '').trim())
    const config = await saveBenchmarkExecutorConfig(username, String(body.clientId || '').trim(), dataset.adapterKey, body.tasksDir)
    return NextResponse.json({ benchmarkKey: dataset.adapterKey, benchmarkConfig: config })
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/execution-targets')
  }
}
