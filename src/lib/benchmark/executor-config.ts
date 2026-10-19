import { prisma } from '@/lib/storage/prisma'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'

export type BenchmarkExecutorConfig = { tasksDir: string }

export function normalizeBenchmarkTasksDir(value: unknown): string {
  if (typeof value !== 'string' || !value.trim().startsWith('/') || value.trim().length > 4096 || /[\0\r\n]/.test(value)) {
    throw new BenchmarkProtocolError('ZSOFT_TASKS_DIR_INVALID', '请填写执行机上 ZSoft 任务目录的绝对路径', 400)
  }
  return value.trim()
}

export async function getBenchmarkExecutorConfig(user: string, clientId: string, benchmarkKey: string): Promise<BenchmarkExecutorConfig | null> {
  const row = await prisma.reliabilityClientConfig.findFirst({
    where: { user, clientId, platform: `benchmark:${benchmarkKey}` },
    select: { overrideJson: true },
  })
  if (!row) return null
  const parsed = JSON.parse(row.overrideJson)
  return { tasksDir: normalizeBenchmarkTasksDir(parsed.tasksDir) }
}

export async function saveBenchmarkExecutorConfig(user: string, clientId: string, benchmarkKey: string, tasksDir: unknown): Promise<BenchmarkExecutorConfig> {
  if (benchmarkKey !== 'zsoft-l1') throw new BenchmarkProtocolError('BENCHMARK_CONFIG_UNSUPPORTED', '该 Benchmark 无需配置本机任务目录', 400)
  const client = await prisma.reliabilityClient.findFirst({ where: { user, clientId, unboundAt: null }, select: { clientId: true } })
  if (!client) throw new BenchmarkProtocolError('EXECUTOR_NOT_FOUND', '执行客户端不存在', 404)
  const config = { tasksDir: normalizeBenchmarkTasksDir(tasksDir) }
  await prisma.reliabilityClientConfig.upsert({
    where: { clientId_platform: { clientId, platform: `benchmark:${benchmarkKey}` } },
    create: { user, clientId, platform: `benchmark:${benchmarkKey}`, overrideJson: JSON.stringify(config), revision: 1 },
    update: { user, overrideJson: JSON.stringify(config), revision: { increment: 1 } },
  })
  return config
}
