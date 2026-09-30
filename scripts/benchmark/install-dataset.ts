import { loadAgentInsightEnv } from '../../src/lib/env'

type CliOptions = {
  benchmarkKey: string
  profileKey: string
  sourcePath: string
  name?: string
  description?: string
  deleteSourceAfterImport: boolean
}

function valueAfter(args: string[], name: string): string {
  const index = args.indexOf(name)
  return index >= 0 ? String(args[index + 1] || '').trim() : ''
}

export function parseInstallDatasetArgs(args: string[]): CliOptions {
  const benchmarkKey = valueAfter(args, '--benchmark')
  const profileKey = valueAfter(args, '--profile')
  const sourcePath = valueAfter(args, '--source')
  if (!benchmarkKey || !profileKey || !sourcePath) {
    throw new Error('用法：npx tsx scripts/benchmark/install-dataset.ts --benchmark <key> --profile <key> --source <file> [--name <name>] [--delete-source-after-import]')
  }
  return {
    benchmarkKey,
    profileKey,
    sourcePath,
    name: valueAfter(args, '--name') || undefined,
    description: valueAfter(args, '--description') || undefined,
    deleteSourceAfterImport: args.includes('--delete-source-after-import'),
  }
}

async function main(): Promise<void> {
  loadAgentInsightEnv()
  const options = parseInstallDatasetArgs(process.argv.slice(2))
  const [{ installBenchmarkDataset }, { prisma }] = await Promise.all([
    import('../../src/lib/benchmark/dataset-admin-service'),
    import('../../src/lib/storage/prisma'),
  ])
  try {
    const result = await installBenchmarkDataset(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } finally {
    await prisma.$disconnect()
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
