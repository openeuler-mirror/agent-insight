import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Prisma } from '@prisma/client'
import { canonicalJson, fingerprintJson, type JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import type { ReadonlySubmissionArtifact } from '../../../packages/benchmark-protocol/src/evaluation-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { resolveAgentInsightDataPath } from '@/lib/env'
import { prisma } from '@/lib/storage/prisma'
import { benchmarkEvaluatorId, getBenchmarkAdapter } from './adapter-registry'
import { benchmarkDatasetOwners } from './dataset-ownership'
import { prepareBenchmarkEvaluation } from './evaluation-preparation-service'
import { dispatchBenchmarkEvaluation } from './evaluation-scheduler'
import type { ImportedSubmission } from './import-submission'

const digestBytes = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash('sha256').update(bytes).digest('hex')}`
const stableId = (prefix: string, value: string) => `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 40)}`

type CaseSnapshot = { id: string; externalCaseId: string; publicPayloadJson: string; privatePayloadJson: string; publicFingerprint: string; privateFingerprint: string }
type ImportedArtifact = ReadonlySubmissionArtifact & { bytes: Buffer; storagePath: string }
type PreparedCase = { ordinal: number; snapshot: CaseSnapshot; publicPayload: JsonValue; privatePayload: JsonValue; caseId: string; runId: string; artifacts: ImportedArtifact[] }

export async function importBenchmarkSubmission(input: ImportedSubmission & { user: string; callbackOrigin: string }) {
  const dataset = await prisma.benchmarkDataset.findFirst({
    where: { OR: [{ id: input.datasetId }, { agentEvalDatasetId: input.datasetId }], user: { in: benchmarkDatasetOwners(input.user) }, status: 'ready' },
    include: { cases: { where: { OR: [{ id: { in: input.cases.map((row) => row.caseId) } }, { externalCaseId: { in: input.cases.map((row) => row.caseId) } }] } } },
  })
  if (!dataset) throw new BenchmarkProtocolError('DATASET_NOT_FOUND', 'Benchmark 数据集不存在或不可用', 404)
  const adapter = getBenchmarkAdapter(dataset.adapterKey)
  let callback: URL
  try { callback = new URL(input.callbackOrigin) }
  catch { throw new BenchmarkProtocolError('BENCHMARK_PUBLIC_BASE_URL_INVALID', '评测回调地址无效', 500) }
  if (!['http:', 'https:'].includes(callback.protocol) || callback.username || callback.password || callback.search || callback.hash) throw new BenchmarkProtocolError('BENCHMARK_PUBLIC_BASE_URL_INVALID', '评测回调地址必须是无凭证的 HTTP(S) URL', 500)
  const experimentId = stableId('exp_import', `${input.user}\0${input.idempotencyKey}`)
  const prepared: PreparedCase[] = []
  const selectedIds = new Set<string>()
  for (const [ordinal, row] of input.cases.entries()) {
    const matches = (dataset.cases as CaseSnapshot[]).filter((item) => item.id === row.caseId || item.externalCaseId === row.caseId)
    const snapshot = matches[0]
    if (!snapshot || matches.length !== 1) throw new BenchmarkProtocolError('CASE_SELECTION_INVALID', 'Case 不属于所选数据集或标识不唯一', 400)
    if (selectedIds.has(snapshot.id)) throw new BenchmarkProtocolError('CASE_SELECTION_INVALID', '导入包含重复 Case', 400)
    selectedIds.add(snapshot.id)
    const publicPayload = JSON.parse(snapshot.publicPayloadJson) as JsonValue
    const privatePayload = JSON.parse(snapshot.privatePayloadJson) as JsonValue
    if (fingerprintJson(publicPayload) !== snapshot.publicFingerprint || fingerprintJson(privatePayload) !== snapshot.privateFingerprint) throw new BenchmarkProtocolError('DATASET_SNAPSHOT_INVALID', '题目快照摘要不一致', 409)
    const caseId = stableId('ecase', `${experimentId}\0${snapshot.id}`)
    const runId = stableId('erun', caseId)
    const artifacts: ImportedArtifact[] = row.artifacts.map((item) => {
      const contract = adapter.manifest.requiredArtifacts.find((required) => required.name === item.name)
      if (!contract) throw new BenchmarkProtocolError('ARTIFACT_CONTRACT_MISMATCH', '导入包含未声明的 Artifact', 400)
      const sha256 = digestBytes(item.bytes)
      const artifactId = stableId('artifact', `${runId}\0${item.name}\0${sha256}`)
      return {
        descriptor: { artifactId, executionRunId: runId, name: item.name, mediaType: contract.mediaType, sha256, sizeBytes: item.bytes.length },
        bytes: item.bytes,
        storagePath: path.posix.join('benchmark-artifacts', runId, `${artifactId}-${item.name}`),
        readBytes: async () => item.bytes,
      }
    })
    await adapter.validateSubmission({ submission: { runId, publicPayload, privatePayload }, artifacts })
    prepared.push({ ordinal, snapshot, publicPayload, privatePayload, caseId, runId, artifacts })
  }
  const importDigest = fingerprintJson({ name: input.name, datasetId: dataset.id, datasetContentHash: dataset.contentHash, cases: prepared.map((row) => ({ caseId: row.snapshot.id, artifacts: row.artifacts.map((item) => item.descriptor) })) })
  const existing = await prisma.experiment.findFirst({ where: { id: experimentId, user: input.user }, select: { configSnapshotJson: true, deletedAt: true } })
  let reused = Boolean(existing)
  const assertSame = (row: { configSnapshotJson: string | null; deletedAt: Date | null }) => {
    if (row.deletedAt || JSON.parse(row.configSnapshotJson || '{}').importDigest !== importDigest) throw new BenchmarkProtocolError('SUBMISSION_IMPORT_CONFLICT', '幂等键已用于其他提交或已删除实验，请使用新键', 409)
  }
  if (existing) assertSame(existing)
  else {
    for (const row of prepared) for (const artifact of row.artifacts) {
      const target = resolveAgentInsightDataPath(artifact.storagePath)
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
      try { await fs.writeFile(target, artifact.bytes, { flag: 'wx', mode: 0o400 }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (digestBytes(await fs.readFile(target)) !== artifact.descriptor.sha256) throw new BenchmarkProtocolError('ARTIFACT_CONTENT_MISMATCH', '已存在的 PoC 文件摘要不一致', 409)
      }
    }
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const concurrent = await tx.experiment.findUnique({ where: { id: experimentId }, select: { configSnapshotJson: true, deletedAt: true } })
        if (concurrent) {
          assertSame(concurrent)
          reused = true
          return
        }
        const limits = [
          { maximum: Number(process.env.AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS || 256), user: undefined },
          { maximum: Number(process.env.AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER || 128), user: input.user },
        ]
        for (const limit of limits) {
          if (!Number.isSafeInteger(limit.maximum) || limit.maximum < 1) throw new Error('Benchmark pending evaluation quota must be a positive integer')
          const occupied = await tx.benchmarkCaseRun.count({ where: { experiment: { ...(limit.user ? { user: limit.user } : {}), deletedAt: null }, status: { in: ['pending', 'preparing', 'dispatching', 'dispatch_unknown', 'running_agent', 'collecting', 'uploading', 'cleaning', 'submitted'] } } })
          if (occupied + prepared.length > limit.maximum) throw new BenchmarkProtocolError('EVALUATION_QUOTA_WAIT', '平台待评测任务已达上限，请稍后使用同一幂等键重试', 503, true)
        }
        await tx.experiment.create({ data: {
          id: experimentId, user: input.user, name: input.name, type: 'single', scope: 'benchmark', status: 'running', agentName: '导入 PoC',
          evaluatorIdsJson: JSON.stringify([benchmarkEvaluatorId(dataset.adapterKey)]),
          configSnapshotJson: JSON.stringify({ datasetId: dataset.id, adapterKey: dataset.adapterKey, submissionSource: 'imported', traceSource: 'import', importDigest, caseIds: prepared.map((row) => row.snapshot.id) }),
          benchmarkBinding: { create: { datasetId: dataset.id, datasetContentHash: dataset.contentHash, adapterKey: dataset.adapterKey, selectionJson: JSON.stringify({ mode: 'explicit', caseIds: prepared.map((row) => row.snapshot.id) }), runConfigJson: JSON.stringify({ submissionSource: 'imported' }), schedulerStatus: 'running', expectedCaseCount: prepared.length, callbackOrigin: callback.toString().replace(/\/$/, '') } },
        } })
        for (const row of prepared) {
          const projection = row.publicPayload as Record<string, JsonValue>
          await tx.experimentCase.create({ data: { id: row.caseId, experimentId, input: String(projection.description || projection.problemStatement || row.snapshot.externalCaseId), datasetInput: row.snapshot.publicPayloadJson, caseValuesJson: row.snapshot.publicPayloadJson } })
          await tx.benchmarkCaseRun.create({ data: {
            id: row.runId, experimentId, experimentCaseId: row.caseId, datasetCaseId: row.snapshot.id, ordinal: row.ordinal,
            status: 'submitted', adapterKey: dataset.adapterKey, clientId: null, submissionSource: 'imported',
            submissionContractJson: canonicalJson(adapter.manifest.requiredArtifacts as unknown as JsonValue),
            publicPayloadJson: row.snapshot.publicPayloadJson, privatePayloadJson: row.snapshot.privatePayloadJson,
            runFactsJson: JSON.stringify({ submissionSource: 'imported' }), finishedAt: new Date(),
            artifacts: { create: row.artifacts.map(({ descriptor: item, storagePath }) => ({ id: item.artifactId, name: item.name, mediaType: item.mediaType, sha256: item.sha256, sizeBytes: item.sizeBytes, storagePath })) },
          } })
          await tx.experimentEvalResult.create({ data: { experimentId, caseId: row.caseId, evaluatorId: benchmarkEvaluatorId(dataset.adapterKey), status: 'pending' } })
        }
      })
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error
      const concurrent = await prisma.experiment.findFirst({ where: { id: experimentId, user: input.user }, select: { configSnapshotJson: true, deletedAt: true } })
      if (!concurrent) throw error
      assertSame(concurrent)
      reused = true
    }
  }
  const evaluations = []
  for (const row of prepared) {
    const evaluation = await prepareBenchmarkEvaluation(row.runId)
    evaluations.push({ caseId: row.snapshot.id, runId: row.runId, evaluationId: evaluation.evaluationRunId })
    if (evaluation.status === 'queued') void dispatchBenchmarkEvaluation(evaluation.evaluationRunId).catch((error) => console.error('[benchmark/import] dispatch failed', error))
  }
  return { experimentId, reused, caseCount: prepared.length, evaluations }
}
