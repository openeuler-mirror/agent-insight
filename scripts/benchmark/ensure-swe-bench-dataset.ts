import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadAgentInsightEnv } from '../../src/lib/env'
export * from '../../benchmarks/swe-bench/dataset/prepare'

export async function ensureSweBenchDataset() {
  const [{ ensureBenchmarkDataset }, { prisma }] = await Promise.all([
    import('../../src/lib/benchmark/dataset-preparation'), import('../../src/lib/storage/prisma'),
  ])
  try { return await ensureBenchmarkDataset('swe-bench') }
  finally { await prisma.$disconnect() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  loadAgentInsightEnv()
  void ensureSweBenchDataset().then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
