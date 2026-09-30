import { loadAgentInsightEnv } from '../../src/lib/env'

function datasetIdFrom(args: string[]): string {
  const index = args.indexOf('--dataset')
  const datasetId = index >= 0 ? String(args[index + 1] || '').trim() : ''
  if (!datasetId) {
    throw new Error('用法：npx tsx scripts/benchmark/refresh-dataset-presentation.ts --dataset <dataset-id>')
  }
  return datasetId
}

async function main(): Promise<void> {
  loadAgentInsightEnv()
  const datasetId = datasetIdFrom(process.argv.slice(2))
  const [{ refreshSystemBenchmarkDatasetPresentation }, { prisma }] = await Promise.all([
    import('../../src/lib/benchmark/dataset-admin-service'),
    import('../../src/lib/storage/prisma'),
  ])
  try {
    const result = await refreshSystemBenchmarkDatasetPresentation(datasetId)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await prisma.$disconnect()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
