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

function datasetFieldType(type: string): 'text' | 'number' | 'boolean' | 'json' {
  if (type === 'number' || type === 'boolean') return type
  return 'text'
}

function datasetFields(adapterKey: string, adapter: ReturnType<typeof getBenchmarkAdapter>): JsonValue {
  const columns = adapter.manifest.presentation?.caseTable.columns || []
  const fields = [{ id: 'input', key: 'input', label: '任务输入', type: 'text', system: true }]
  const seen = new Set(['input'])
  for (const column of columns) {
    const key = column.path === 'externalCaseId'
      ? 'externalCaseId'
      : column.path.startsWith('values.')
        ? column.path.slice('values.'.length)
        : column.path
    if (!key || key.includes('.') || seen.has(key)) continue
    seen.add(key)
    fields.push({
      id: key,
      key,
      label: column.label,
      type: datasetFieldType(column.type),
      system: true,
    })
  }
  if (fields.length === 1) {
    fields.push({ id: 'externalCaseId', key: 'externalCaseId', label: `${adapterKey} Case`, type: 'text', system: true })
  }
  return fields as JsonValue
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
      catalogProjection: split.catalogProjection,
    }
  })
  const contentHash = fingerprintJson(
    rows.map((row) => ({
      externalCaseId: row.externalCaseId,
      sourceFingerprint: row.sourceFingerprint,
    })),
  )
  const sourceJson = canonicalJson((input.source || {}) as JsonValue)
  const publicCases = rows.map((row) => ({
    id: row.id,
    input: row.catalogProjection.input,
    expectedOutput: '',
    evaluationFocus: '',
    tags: [...(row.catalogProjection.tags || [])],
    trajectory: '',
    values: {
      ...row.catalogProjection.values,
      externalCaseId: row.externalCaseId,
    },
  }))
  const publicCasesJson = canonicalJson(publicCases)
  const fieldsJson = canonicalJson(datasetFields(input.adapterKey, adapter))
  const referenceCasesJson = canonicalJson(
    publicCases.map(({ id, input: caseInput, expectedOutput, evaluationFocus, tags }) => ({
      id,
      input: caseInput,
      expectedOutput,
      evaluationFocus,
      tags,
    })) as JsonValue,
  )
  const persistenceRows = rows.map((row) => ({
    id: row.id,
    externalCaseId: row.externalCaseId,
    rawCaseJson: row.rawCaseJson,
    publicPayloadJson: row.publicPayloadJson,
    privatePayloadJson: row.privatePayloadJson,
    sourceFingerprint: row.sourceFingerprint,
    publicFingerprint: row.publicFingerprint,
    privateFingerprint: row.privateFingerprint,
    ordinal: row.ordinal,
  }))
  const sourceProfile = typeof input.source?.profileKey === 'string' ? input.source.profileKey : ''
  const datasetTags = [adapter.manifest.displayName, sourceProfile].filter(Boolean)

  const sameContent = await prisma.benchmarkDataset.findFirst({
    where: { user, adapterKey: input.adapterKey, contentHash },
  })
  if (sameContent) {
    if (sameContent.status !== 'ready') {
      await prisma.benchmarkDataset.update({
        where: { id: sameContent.id },
        data: { status: 'ready' },
      })
    }
    return {
      id: sameContent.id,
      contentHash,
      caseCount: sameContent.caseCount,
      reused: true,
    }
  }

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
          tagsJson: JSON.stringify(datasetTags),
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
          cases: { create: persistenceRows },
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
        tagsJson: JSON.stringify(datasetTags),
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
        cases: { create: persistenceRows },
      },
    })
  })

  return { id: result.id, contentHash, caseCount: rows.length, reused: false }
}
