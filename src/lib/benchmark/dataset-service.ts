import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import type { JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { canonicalJson, fingerprintJson } from '../../../packages/benchmark-protocol/src/contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { prisma } from '@/lib/storage/prisma'

import { getBenchmarkAdapter } from './adapter-registry'

type ImportBenchmarkDatasetInput = {
  user: string
  name: string
  description?: string
  adapterKey: string
  source?: Record<string, JsonValue>
  cases: unknown[]
}

function newDatasetCaseId(): string {
  return `bdc_${randomUUID().replaceAll('-', '')}`
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

export async function importBenchmarkDataset(input: ImportBenchmarkDatasetInput): Promise<{
  id: string
  contentHash: string
  caseCount: number
  reused: boolean
}> {
  const user = input.user.trim()
  const name = input.name.trim()
  if (!user || !name) {
    throw new BenchmarkProtocolError('DATASET_IDENTITY_INVALID', '数据集 user 和 name 不能为空', 400)
  }
  if (!Array.isArray(input.cases) || input.cases.length < 1) {
    throw new BenchmarkProtocolError('DATASET_EMPTY', 'Benchmark 数据集至少包含一个 Case', 400)
  }

  const adapter = getBenchmarkAdapter(input.adapterKey)
  const seenCaseIds = new Set<string>()
  const rows = input.cases.map((rawCase, ordinal) => {
    const split = adapter.validateAndSplitCase(rawCase)
    if (seenCaseIds.has(split.externalCaseId)) {
      throw new BenchmarkProtocolError(
        'DATASET_CASE_DUPLICATE',
        `数据集包含重复 Case：${split.externalCaseId}`,
        409,
      )
    }
    seenCaseIds.add(split.externalCaseId)
    const raw = asJsonValue(rawCase)
    return {
      id: newDatasetCaseId(),
      externalCaseId: split.externalCaseId,
      rawCaseJson: canonicalJson(raw),
      publicPayloadJson: canonicalJson(split.publicPayload),
      privatePayloadJson: canonicalJson(split.privatePayload),
      sourceFingerprint: fingerprintJson(raw),
      publicFingerprint: split.publicFingerprint,
      privateFingerprint: split.privateFingerprint,
      ordinal,
    }
  })
  const contentHash = fingerprintJson(
    rows.map((row) => ({
      externalCaseId: row.externalCaseId,
      sourceFingerprint: row.sourceFingerprint,
    })),
  )
  const sourceJson = canonicalJson((input.source || {}) as JsonValue)
  const publicCasesJson = canonicalJson(
    rows.map((row) => {
      const payload = JSON.parse(row.publicPayloadJson) as Record<string, JsonValue>
      return {
        id: row.id,
        input: typeof payload.problemStatement === 'string' ? payload.problemStatement : '',
        expectedOutput: '',
        evaluationFocus: '',
        tags: ['SWE-bench Verified'],
        trajectory: '',
        values: {
          instance_id: payload.instanceId,
          repo: payload.repo,
          base_commit: payload.baseCommit,
          version: payload.repositoryVersion || '',
          hints_text: payload.hintsText || '',
        },
      }
    }),
  )
  const fieldsJson = canonicalJson([
    { id: 'input', key: 'input', label: '问题描述', type: 'text', system: true },
    { id: 'instance_id', key: 'instance_id', label: 'Instance ID', type: 'text', system: true },
    { id: 'repo', key: 'repo', label: '代码仓库', type: 'text', system: true },
    { id: 'base_commit', key: 'base_commit', label: '基线提交', type: 'text', system: true },
    { id: 'version', key: 'version', label: '版本', type: 'text', system: true },
  ] as JsonValue)
  const referenceCasesJson = canonicalJson(
    rows.map((row) => {
      const payload = JSON.parse(row.publicPayloadJson) as Record<string, JsonValue>
      return {
        id: row.id,
        input: typeof payload.problemStatement === 'string' ? payload.problemStatement : '',
        expectedOutput: '',
        evaluationFocus: '',
        tags: ['SWE-bench Verified'],
      }
    }) as JsonValue,
  )

  const existing = await prisma.benchmarkDataset.findUnique({
    where: { user_name: { user, name } },
    include: { _count: { select: { bindings: true } } },
  })
  if (existing?.contentHash === contentHash && existing.adapterKey === input.adapterKey) {
    return { id: existing.id, contentHash, caseCount: existing.caseCount, reused: true }
  }
  if (existing?._count.bindings) {
    throw new BenchmarkProtocolError(
      'DATASET_IN_USE',
      '该数据集已被实验引用，不能用不同内容覆盖；请使用新的数据集名称',
      409,
    )
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    if (existing) {
      await tx.benchmarkDatasetCase.deleteMany({ where: { datasetId: existing.id } })
      await tx.agentEvalDataset.update({
        where: { id: existing.agentEvalDatasetId },
        data: {
          description: input.description || '',
          casesJson: publicCasesJson,
          fieldsJson,
          tagsJson: JSON.stringify(['SWE-bench', 'Verified']),
          caseCount: rows.length,
          referenceCasesJson,
          datasetKind: 'benchmark',
          projectionReady: true,
        },
      })
      const dataset = await tx.benchmarkDataset.update({
        where: { id: existing.id },
        data: {
          adapterKey: input.adapterKey,
          contentHash,
          status: 'ready',
          caseCount: rows.length,
          sourceJson,
          cases: { create: rows },
        },
      })
      return dataset
    }

    const agentEvalDatasetId = `aeds_${randomUUID().replaceAll('-', '')}`
    await tx.agentEvalDataset.create({
      data: {
        id: agentEvalDatasetId,
        user,
        name,
        description: input.description || '',
        casesJson: publicCasesJson,
        fieldsJson,
        tagsJson: JSON.stringify(['SWE-bench', 'Verified']),
        caseCount: rows.length,
        referenceCasesJson,
        datasetKind: 'benchmark',
        projectionReady: true,
      },
    })
    return tx.benchmarkDataset.create({
      data: {
        agentEvalDatasetId,
        user,
        name,
        adapterKey: input.adapterKey,
        contentHash,
        status: 'ready',
        caseCount: rows.length,
        sourceJson,
        cases: { create: rows },
      },
    })
  })

  return { id: result.id, contentHash, caseCount: rows.length, reused: false }
}
