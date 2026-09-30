import { prisma } from '@/lib/storage/prisma'
import type { BenchmarkPresentation } from '../../../packages/benchmark-protocol/src/contracts'

import { getBenchmarkAdapter } from './adapter-registry'
import {
  benchmarkDatasetOwners,
  SYSTEM_BENCHMARK_DATASET_OWNER,
} from './dataset-ownership'

export type PublicBenchmarkDatasetMeta = {
  readOnly: true
  shared: boolean
  benchmark: {
    adapterKey: string
    evaluatorKey: string
    displayName: string
    status: string
    profileKey?: string
    presentation?: BenchmarkPresentation
  }
}

export async function publicBenchmarkDatasetMeta(
  user: string,
  datasetIds: string[],
): Promise<Map<string, PublicBenchmarkDatasetMeta>> {
  if (!datasetIds.length) return new Map()
  const rows = await prisma.benchmarkDataset.findMany({
    where: { user: { in: benchmarkDatasetOwners(user) }, agentEvalDatasetId: { in: datasetIds } },
    select: { agentEvalDatasetId: true, user: true, adapterKey: true, status: true, sourceJson: true },
  })
  return new Map(rows.map((row: {
    agentEvalDatasetId: string
    user: string
    adapterKey: string
    status: string
    sourceJson: string
  }) => {
    let profileKey: string | undefined
    try {
      const source = JSON.parse(row.sourceJson) as { profileKey?: unknown }
      if (typeof source.profileKey === 'string' && source.profileKey) profileKey = source.profileKey
    } catch {
      profileKey = undefined
    }
    let displayName = row.adapterKey
    let evaluatorKey = ''
    let presentation: BenchmarkPresentation | undefined
    let status = row.status
    try {
      const manifest = getBenchmarkAdapter(row.adapterKey).manifest
      displayName = manifest.displayName
      evaluatorKey = manifest.evaluation.evaluatorKey
      presentation = manifest.presentation
    } catch {
      status = 'adapter_missing'
    }
    return [row.agentEvalDatasetId, {
      readOnly: true as const,
      shared: row.user === SYSTEM_BENCHMARK_DATASET_OWNER,
      benchmark: {
        adapterKey: row.adapterKey,
        evaluatorKey,
        displayName,
        status,
        ...(profileKey ? { profileKey } : {}),
        ...(presentation ? { presentation } : {}),
      },
    }]
  }))
}

export async function isReadOnlyBenchmarkDataset(user: string, datasetId: string): Promise<boolean> {
  return Boolean(await prisma.benchmarkDataset.findFirst({
    where: { user: { in: benchmarkDatasetOwners(user) }, agentEvalDatasetId: datasetId },
    select: { id: true },
  }))
}

export async function decoratePublicBenchmarkDatasets<T extends { id: string }>(
  user: string,
  datasets: T[],
): Promise<Array<T & Partial<PublicBenchmarkDatasetMeta>>> {
  const meta = await publicBenchmarkDatasetMeta(user, datasets.map((item) => item.id))
  return datasets.map((dataset) => ({ ...dataset, ...(meta.get(dataset.id) || {}) }))
}
