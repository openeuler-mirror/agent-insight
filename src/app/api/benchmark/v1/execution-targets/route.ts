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

import { resolveUser } from '@/lib/auth/auth'
import { getBenchmarkAdapter } from '@/lib/benchmark/adapter-registry'
import { benchmarkErrorResponse } from '@/lib/benchmark/api-error'
import { benchmarkDatasetOwners } from '@/lib/benchmark/dataset-ownership'
import { listBenchmarkExecutionTargets } from '@/lib/benchmark/execution-targets'
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
    return NextResponse.json({ benchmarkKey: dataset.adapterKey, items })
  } catch (error) {
    return benchmarkErrorResponse(error, 'benchmark/execution-targets')
  }
}
