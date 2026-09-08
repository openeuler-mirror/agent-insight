import { prisma } from '@/lib/storage/prisma'

export type PublicBenchmarkDatasetMeta = {
  readOnly: true
  benchmark: {
    adapterKey: string
    status: string
  }
}

export async function publicBenchmarkDatasetMeta(
  user: string,
  datasetIds: string[],
): Promise<Map<string, PublicBenchmarkDatasetMeta>> {
  if (!datasetIds.length) return new Map()
  const rows = await prisma.benchmarkDataset.findMany({
    where: { user, agentEvalDatasetId: { in: datasetIds } },
    select: { agentEvalDatasetId: true, adapterKey: true, status: true },
  })
  return new Map(rows.map((row: { agentEvalDatasetId: string; adapterKey: string; status: string }) => [row.agentEvalDatasetId, {
    readOnly: true as const,
    benchmark: { adapterKey: row.adapterKey, status: row.status },
  }]))
}

export async function isReadOnlyBenchmarkDataset(user: string, datasetId: string): Promise<boolean> {
  return Boolean(await prisma.benchmarkDataset.findFirst({
    where: { user, agentEvalDatasetId: datasetId },
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
