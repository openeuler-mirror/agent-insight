import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { canonicalJson } from '../../../packages/benchmark-protocol/src/contracts'
import { prisma } from '@/lib/storage/prisma'

import { getBenchmarkAdapter } from './adapter-registry'
import { getBenchmarkDatasetLoader } from './dataset-loader-registry'
import { SYSTEM_BENCHMARK_DATASET_OWNER } from './dataset-ownership'
import { buildBenchmarkDatasetFields, importBenchmarkDataset } from './dataset-service'

export type InstalledSystemBenchmarkDataset = {
  id: string
  agentEvalDatasetId: string
  name: string
  caseCount: number
}

function resolveSourcePath(sourcePath: string): string {
  const trimmed = sourcePath.trim()
  if (!trimmed) throw new BenchmarkProtocolError('DATASET_SOURCE_REQUIRED', '--source 不能为空', 400)
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.resolve(os.homedir(), trimmed.slice(2))
  return path.resolve(trimmed)
}

async function sourceSha256(sourcePath: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(sourcePath)) hash.update(chunk)
  return `sha256:${hash.digest('hex')}`
}

export async function findInstalledSystemBenchmarkDataset(input: {
  benchmarkKey: string
  profileKey: string
}): Promise<InstalledSystemBenchmarkDataset | null> {
  const adapter = getBenchmarkAdapter(input.benchmarkKey)
  const profiles = adapter.manifest.dataset?.profiles || []
  const profile = profiles.find((item) => item.key === input.profileKey)
  if (!profile) {
    throw new BenchmarkProtocolError(
      'DATASET_PROFILE_NOT_FOUND',
      `Benchmark ${input.benchmarkKey} 没有 Dataset Profile：${input.profileKey}`,
      404,
    )
  }

  const candidates = await prisma.benchmarkDataset.findMany({
    where: {
      user: SYSTEM_BENCHMARK_DATASET_OWNER,
      adapterKey: input.benchmarkKey,
      status: 'ready',
      ...(profile.expectedCaseCount == null ? {} : { caseCount: profile.expectedCaseCount }),
    },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      agentEvalDatasetId: true,
      name: true,
      caseCount: true,
      sourceJson: true,
    },
  })

  for (const candidate of candidates) {
    try {
      const source = JSON.parse(candidate.sourceJson) as { profileKey?: unknown }
      if (source.profileKey === profile.key) return candidate
    } catch {
      // Legacy rows can have non-profile source metadata; the fallback below handles them.
    }
  }

  if (profiles.length === 1 && candidates.length > 0) return candidates[0]
  return null
}

export async function installBenchmarkDataset(input: {
  benchmarkKey: string
  profileKey: string
  sourcePath: string
  name?: string
  description?: string
  deleteSourceAfterImport?: boolean
}): Promise<{
  id: string
  contentHash: string
  caseCount: number
  reused: boolean
  sourceSha256: string
  sourceDeleted: boolean
}> {
  const sourcePath = resolveSourcePath(input.sourcePath)
  let stat: fs.Stats
  try {
    stat = await fs.promises.lstat(sourcePath)
  } catch {
    throw new BenchmarkProtocolError('DATASET_SOURCE_NOT_FOUND', `数据集文件不存在：${sourcePath}`, 404)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new BenchmarkProtocolError('DATASET_SOURCE_INVALID', '--source 必须是普通文件，不能是目录或符号链接', 400)
  }

  const adapter = getBenchmarkAdapter(input.benchmarkKey)
  const profile = adapter.manifest.dataset?.profiles.find((item) => item.key === input.profileKey)
  if (!profile) {
    throw new BenchmarkProtocolError(
      'DATASET_PROFILE_NOT_FOUND',
      `Benchmark ${input.benchmarkKey} 没有 Dataset Profile：${input.profileKey}`,
      404,
    )
  }
  const extension = path.extname(sourcePath).toLowerCase()
  if (!profile.acceptedExtensions.includes(extension)) {
    throw new BenchmarkProtocolError(
      'DATASET_SOURCE_FORMAT_INVALID',
      `${profile.displayName} 只接受 ${profile.acceptedExtensions.join(', ')} 文件`,
      400,
    )
  }

  const [fileSha256, loader] = await Promise.all([
    sourceSha256(sourcePath),
    Promise.resolve(getBenchmarkDatasetLoader(input.benchmarkKey, sourcePath)),
  ])
  const cases: unknown[] = []
  for await (const rawCase of loader.loadCases(sourcePath)) cases.push(rawCase)
  if (profile.expectedCaseCount != null && cases.length !== profile.expectedCaseCount) {
    throw new BenchmarkProtocolError(
      'DATASET_CASE_COUNT_INVALID',
      `${profile.displayName} 应包含 ${profile.expectedCaseCount} 个 Case，实际为 ${cases.length}`,
      400,
    )
  }

  const imported = await importBenchmarkDataset({
    user: SYSTEM_BENCHMARK_DATASET_OWNER,
    name: input.name?.trim() || profile.displayName,
    description: input.description?.trim() || `${profile.displayName} 平台共享数据集`,
    adapterKey: input.benchmarkKey,
    source: {
      kind: 'benchmark-dataset-import',
      profileKey: profile.key,
      fileName: path.basename(sourcePath),
      sha256: fileSha256,
    },
    cases,
  })

  let sourceDeleted = false
  if (input.deleteSourceAfterImport) {
    await fs.promises.unlink(sourcePath)
    sourceDeleted = true
  }
  return { ...imported, sourceSha256: fileSha256, sourceDeleted }
}

export async function removeSystemBenchmarkDataset(datasetId: string): Promise<{
  id: string
  action: 'deleted' | 'archived'
}> {
  const id = datasetId.trim()
  if (!id) throw new BenchmarkProtocolError('DATASET_ID_REQUIRED', '--dataset 不能为空', 400)
  const dataset = await prisma.benchmarkDataset.findFirst({
    where: {
      user: SYSTEM_BENCHMARK_DATASET_OWNER,
      OR: [{ id }, { agentEvalDatasetId: id }],
    },
    include: { _count: { select: { bindings: true } } },
  })
  if (!dataset) {
    throw new BenchmarkProtocolError('BENCHMARK_DATASET_NOT_FOUND', '平台 Benchmark 数据集不存在', 404)
  }
  if (dataset._count.bindings > 0) {
    await prisma.benchmarkDataset.update({ where: { id: dataset.id }, data: { status: 'archived' } })
    return { id: dataset.id, action: 'archived' }
  }
  await prisma.agentEvalDataset.delete({ where: { id: dataset.agentEvalDatasetId } })
  return { id: dataset.id, action: 'deleted' }
}

export async function refreshSystemBenchmarkDatasetPresentation(datasetId: string): Promise<{
  id: string
  agentEvalDatasetId: string
  adapterKey: string
}> {
  const id = datasetId.trim()
  if (!id) throw new BenchmarkProtocolError('DATASET_ID_REQUIRED', '--dataset 不能为空', 400)
  const dataset = await prisma.benchmarkDataset.findFirst({
    where: {
      user: SYSTEM_BENCHMARK_DATASET_OWNER,
      OR: [{ id }, { agentEvalDatasetId: id }],
    },
    select: { id: true, agentEvalDatasetId: true, adapterKey: true },
  })
  if (!dataset) {
    throw new BenchmarkProtocolError('BENCHMARK_DATASET_NOT_FOUND', '平台 Benchmark 数据集不存在', 404)
  }
  const adapter = getBenchmarkAdapter(dataset.adapterKey)
  await prisma.agentEvalDataset.update({
    where: { id: dataset.agentEvalDatasetId },
    data: { fieldsJson: canonicalJson(buildBenchmarkDatasetFields(dataset.adapterKey, adapter)) },
  })
  return dataset
}
