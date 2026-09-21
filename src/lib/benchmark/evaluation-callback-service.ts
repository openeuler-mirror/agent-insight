import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Prisma } from '@prisma/client'

import { canonicalJson, fingerprintJson, type JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import type {
  BenchmarkEvaluationCompletion,
  BenchmarkEvaluationProgress,
  NormalizedBenchmarkResult,
} from '../../../packages/benchmark-protocol/src/evaluator-contracts'
import type { EvaluationJob } from '../../../packages/benchmark-protocol/src/evaluation-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { resolveAgentInsightDataPath } from '@/lib/env'
import { prisma } from '@/lib/storage/prisma'

import { getBenchmarkAdapter } from './adapter-registry'
import { scheduleBenchmarkEvaluationContinuation } from './evaluation-continuation-service'

const ACTIVE_STATUSES = new Set(['queued', 'dispatch_unknown', 'running_evaluator'])
const COMPLETED_EVALUATION_STATUSES = new Set(['completed', 'failed', 'submission_invalid'])
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024

type StoredEvaluationArtifact = {
  id: string
  evaluationId: string
  name: string
  kind: string
  mediaType: string
  sha256: string
  sizeBytes: number
  storagePath: string
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function evaluationOrThrow(evaluationId: string) {
  const evaluation = await prisma.benchmarkEvaluation.findUnique({
    where: { id: evaluationId },
    include: {
      artifacts: { orderBy: { createdAt: 'asc' } },
      caseRun: { select: { experimentId: true, experimentCaseId: true } },
    },
  })
  if (!evaluation) {
    throw new BenchmarkProtocolError('EVALUATION_NOT_FOUND', '评测 Run 不存在', 404)
  }
  return evaluation
}

function assertPlainObject(value: unknown, code: string, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BenchmarkProtocolError(code, message, 400)
  }
}

function frozenEvaluationJob(requestJson: string): EvaluationJob {
  try {
    const job = JSON.parse(requestJson) as EvaluationJob
    if (job && typeof job === 'object' && job.protocolVersion === 'benchmark-evaluation/v1') {
      return job
    }
  } catch {}
  throw new BenchmarkProtocolError(
    'EVALUATION_REQUEST_INVALID',
    '冻结的评测任务不合法',
    500,
  )
}

async function normalizedEvidenceArtifacts(
  artifacts: readonly StoredEvaluationArtifact[],
): Promise<Array<{
  artifactId: string
  evaluationId: string
  name: string
  kind: string
  mediaType: string
  sha256: `sha256:${string}`
  sizeBytes: number
  jsonContent?: JsonValue
}>> {
  const root = path.resolve(resolveAgentInsightDataPath())
  return Promise.all(artifacts.map(async (artifact) => {
    let jsonContent: JsonValue | undefined
    if (artifact.mediaType.split(';', 1)[0].trim().toLowerCase() === 'application/json') {
      const absolutePath = path.resolve(root, artifact.storagePath)
      if (!absolutePath.startsWith(`${root}${path.sep}`)) {
        throw new BenchmarkProtocolError(
          'EVALUATION_ARTIFACT_PATH_INVALID',
          '评测证据存储路径不合法',
          500,
        )
      }
      try {
        const bytes = await fs.readFile(absolutePath)
        if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256) {
          throw new Error('digest mismatch')
        }
        jsonContent = JSON.parse(bytes.toString('utf8')) as JsonValue
      } catch {
        throw new BenchmarkProtocolError(
          'EVALUATION_EVIDENCE_JSON_INVALID',
          `评测证据 ${artifact.name} 不是有效的 JSON 文件或摘要不匹配`,
          422,
          false,
          { phase: 'evidence-decoding' },
        )
      }
    }
    return {
      artifactId: artifact.id,
      evaluationId: artifact.evaluationId,
      name: artifact.name,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256 as `sha256:${string}`,
      sizeBytes: artifact.sizeBytes,
      ...(jsonContent === undefined ? {} : { jsonContent }),
    }
  }))
}

export async function recordBenchmarkEvaluationProgress(input: {
  evaluationId: string
  progress: BenchmarkEvaluationProgress
}): Promise<{ accepted: true; desiredState: 'continue' }> {
  const evaluation = await evaluationOrThrow(input.evaluationId)
  if (!ACTIVE_STATUSES.has(evaluation.status)) {
    throw new BenchmarkProtocolError('EVALUATION_NOT_ACTIVE', '评测 Run 已不接受进度回调', 409)
  }
  const allowedStages = [
    'downloading_artifacts',
    'preparing_runtime',
    'resolving_image',
    'running_harness',
    'collecting_evidence',
    'uploading_evidence',
    'cleaning',
  ] as const
  assertPlainObject(input.progress, 'EVALUATION_PROGRESS_INVALID', '评测进度格式不合法')
  const stage = input.progress.stage
  if (
    input.progress.kind !== 'evaluation'
    || !allowedStages.includes(stage)
    || !Number.isFinite(Date.parse(input.progress.occurredAt))
  ) {
    throw new BenchmarkProtocolError('EVALUATION_PROGRESS_INVALID', '评测进度格式不合法', 400)
  }
  const previous = evaluation.progressJson
    ? JSON.parse(evaluation.progressJson) as Partial<BenchmarkEvaluationProgress>
    : null
  if (previous?.stage && allowedStages.indexOf(stage) < allowedStages.indexOf(previous.stage)) {
    return { accepted: true, desiredState: 'continue' }
  }
  const updated = await prisma.benchmarkEvaluation.updateMany({
    where: {
      id: input.evaluationId,
      status: { in: [...ACTIVE_STATUSES] },
      completionDigest: null,
    },
    data: {
      status: 'running_evaluator',
      progressJson: canonicalJson(input.progress as unknown as JsonValue),
      lastProgressAt: new Date(),
      startedAt: evaluation.startedAt || new Date(),
    },
  })
  if (updated.count !== 1) {
    throw new BenchmarkProtocolError('EVALUATION_NOT_ACTIVE', '评测 Run 已不接受进度回调', 409)
  }
  return { accepted: true, desiredState: 'continue' }
}

export async function storeBenchmarkEvaluationArtifact(input: {
  evaluationId: string
  name: string
  kind: string
  mediaType: string
  expectedSha256: string
  bytes: Uint8Array
}): Promise<{ artifactId: string; sha256: string; size: number }> {
  const evaluation = await evaluationOrThrow(input.evaluationId)
  if (!ACTIVE_STATUSES.has(evaluation.status)) {
    throw new BenchmarkProtocolError('EVALUATION_NOT_ACTIVE', '评测 Run 已不接受证据 Artifact', 409)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.name)) {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_NAME_INVALID', '证据 Artifact 名称不合法', 400)
  }
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(input.kind)) {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_KIND_INVALID', '证据 Artifact kind 不合法', 400)
  }
  if (!input.mediaType.trim() || input.mediaType.length > 128) {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_MEDIA_TYPE_INVALID', '证据 Artifact mediaType 不合法', 400)
  }
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_EVIDENCE_BYTES) {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_SIZE_INVALID', '证据 Artifact 为空或超过 64 MiB', 422)
  }
  const digest = sha256(input.bytes)
  if (digest !== input.expectedSha256) {
    throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_DIGEST_MISMATCH', '证据 Artifact SHA-256 不匹配', 422)
  }
  const existing = evaluation.artifacts.find((artifact: StoredEvaluationArtifact) => artifact.name === input.name)
  if (existing) {
    if (
      existing.kind !== input.kind
      || existing.mediaType !== input.mediaType
      || existing.sha256 !== digest
      || existing.sizeBytes !== input.bytes.byteLength
    ) {
      throw new BenchmarkProtocolError('EVALUATION_ARTIFACT_CONFLICT', '同名证据 Artifact 内容冲突', 409)
    }
    return { artifactId: existing.id, sha256: existing.sha256, size: existing.sizeBytes }
  }

  const artifactId = `beart_${randomUUID().replaceAll('-', '')}`
  const relativePath = path.join(
    'benchmark-evaluation-artifacts',
    input.evaluationId,
    `${artifactId}-${input.name}`,
  )
  const absolutePath = resolveAgentInsightDataPath(relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 })
  const tempPath = `${absolutePath}.${process.pid}.tmp`
  await fs.writeFile(tempPath, input.bytes, { mode: 0o600 })
  await fs.rename(tempPath, absolutePath)
  try {
    await prisma.benchmarkEvaluationArtifact.create({
      data: {
        id: artifactId,
        evaluationId: input.evaluationId,
        name: input.name,
        kind: input.kind,
        mediaType: input.mediaType,
        sha256: digest,
        sizeBytes: input.bytes.byteLength,
        storagePath: relativePath,
      },
    })
  } catch (error) {
    await fs.rm(absolutePath, { force: true }).catch(() => undefined)
    throw error
  }
  return { artifactId, sha256: digest, size: input.bytes.byteLength }
}

function validateCompletion(value: BenchmarkEvaluationCompletion): void {
  assertPlainObject(value, 'EVALUATION_COMPLETION_INVALID', '评测终态格式不合法')
  if (
    !['completed', 'submission_invalid', 'failed'].includes(value.status)
    || !Array.isArray(value.evidenceArtifactIds)
    || value.evidenceArtifactIds.some((artifactId) => (
      typeof artifactId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(artifactId)
    ))
    || new Set(value.evidenceArtifactIds).size !== value.evidenceArtifactIds.length
  ) {
    throw new BenchmarkProtocolError('EVALUATION_COMPLETION_INVALID', '评测终态格式不合法', 400)
  }
  assertPlainObject(value.rawResult, 'EVALUATION_COMPLETION_INVALID', '评测终态缺少原生结果')
  assertPlainObject(value.runtimeFacts, 'EVALUATION_COMPLETION_INVALID', '评测终态缺少运行事实')
  assertPlainObject(value.cleanup, 'EVALUATION_COMPLETION_INVALID', '评测终态缺少清理结果')
  if (value.status === 'completed' && value.error != null) {
    throw new BenchmarkProtocolError('EVALUATION_COMPLETION_INVALID', '成功终态不能携带错误信息', 400)
  }
  if (value.status !== 'completed') {
    assertPlainObject(value.error, 'EVALUATION_COMPLETION_INVALID', '失败终态缺少错误信息')
    if (
      typeof value.error.code !== 'string'
      || !value.error.code.trim()
      || typeof value.error.message !== 'string'
      || !value.error.message.trim()
      || typeof value.error.retryable !== 'boolean'
    ) {
      throw new BenchmarkProtocolError('EVALUATION_COMPLETION_INVALID', '失败终态错误信息不合法', 400)
    }
  }
}

async function writeExperimentResult(input: {
  tx: Prisma.TransactionClient
  evaluation: Awaited<ReturnType<typeof evaluationOrThrow>>
  normalized: NormalizedBenchmarkResult
}): Promise<void> {
  const evaluatorId = `benchmark:${input.evaluation.evaluatorKey}`
  const normalized = input.normalized
  await input.tx.experimentEvalResult.upsert({
    where: {
      caseId_evaluatorId: {
        caseId: input.evaluation.caseRun.experimentCaseId,
        evaluatorId,
      },
    },
    create: {
      experimentId: input.evaluation.caseRun.experimentId,
      caseId: input.evaluation.caseRun.experimentCaseId,
      evaluatorId,
      status: normalized.status,
      verdict: normalized.verdict || null,
      summary: normalized.summary,
      score: normalized.score,
      pointsJson: canonicalJson(normalized.points as unknown as JsonValue),
      evidenceJson: canonicalJson(normalized.evidence),
      errorMessage: normalized.errorMessage || null,
      attempts: 1,
    },
    update: {
      status: normalized.status,
      verdict: normalized.verdict || null,
      summary: normalized.summary,
      score: normalized.score,
      pointsJson: canonicalJson(normalized.points as unknown as JsonValue),
      evidenceJson: canonicalJson(normalized.evidence),
      errorMessage: normalized.errorMessage || null,
      attempts: { increment: 1 },
    },
  })
}

function normalizationFailure(error: unknown): { code: string; category: string } {
  if (!(error instanceof BenchmarkProtocolError)) {
    return { code: 'RESULT_MAPPING_FAILED', category: 'RESULT_MAPPING_FAILED' }
  }
  return {
    code: error.code,
    category: error.details?.phase === 'evidence-decoding'
      ? 'EVIDENCE_INVALID'
      : 'BENCHMARK_RESULT_INVALID',
  }
}

function nonRetryableNormalizationError(
  code: string,
  message: string,
  errorCategory = 'BENCHMARK_RESULT_INVALID',
): BenchmarkProtocolError {
  return new BenchmarkProtocolError(code, message, 422, false, {
    acceptedRawResult: true,
    evaluationStatus: 'normalization_failed',
    errorCategory,
  })
}

function finalizationLostError(): BenchmarkProtocolError {
  return new BenchmarkProtocolError(
    'EVALUATION_NOT_ACTIVE',
    '评测 Run 已被平台终止，不能再覆盖终态',
    409,
    false,
  )
}

function isFinalizationLost(error: unknown): boolean {
  return error instanceof BenchmarkProtocolError && error.code === 'EVALUATION_NOT_ACTIVE'
}

async function recordPersistenceFailure(evaluationId: string, error: unknown): Promise<never> {
  const message = error instanceof Error ? error.message : '评测结果落库失败'
  await prisma.benchmarkEvaluation.update({
    where: { id: evaluationId },
    data: {
      status: 'normalization_failed',
      failureCode: 'RESULT_PERSISTENCE_FAILED',
      failureMessage: message,
      finishedAt: new Date(),
    },
  })
  throw new BenchmarkProtocolError('RESULT_PERSISTENCE_FAILED', message, 500, true, {
    acceptedRawResult: true,
    evaluationStatus: 'normalization_failed',
  })
}

export async function completeBenchmarkEvaluation(input: {
  evaluationId: string
  completion: BenchmarkEvaluationCompletion
}): Promise<{
  accepted: true
  evaluationStatus: string
  normalizationStatus: 'completed'
  normalizedResult?: NormalizedBenchmarkResult
}> {
  validateCompletion(input.completion)
  const completionDigest = fingerprintJson(input.completion as unknown as JsonValue)
  let evaluation = await evaluationOrThrow(input.evaluationId)
  if (evaluation.completionDigest) {
    if (evaluation.completionDigest !== completionDigest) {
      throw new BenchmarkProtocolError('EVALUATION_COMPLETION_CONFLICT', '评测终态内容冲突', 409)
    }
    if (COMPLETED_EVALUATION_STATUSES.has(evaluation.status)) {
      if (evaluation.normalizedResultJson) {
        if (evaluation.continuationStatus !== 'completed') {
          scheduleBenchmarkEvaluationContinuation(evaluation.id)
        }
        return {
          accepted: true,
          evaluationStatus: evaluation.status,
          normalizationStatus: 'completed',
          normalizedResult: JSON.parse(evaluation.normalizedResultJson) as NormalizedBenchmarkResult,
        }
      }
      throw new BenchmarkProtocolError(
        'EVALUATION_NOT_ACTIVE',
        '评测 Run 已终止，不能恢复未完成的归一化',
        409,
      )
    }
    if (
      evaluation.status === 'normalization_failed'
      && evaluation.failureCode !== 'RESULT_PERSISTENCE_FAILED'
    ) {
      if (evaluation.continuationStatus !== 'completed') {
        scheduleBenchmarkEvaluationContinuation(evaluation.id)
      }
      throw nonRetryableNormalizationError(
        evaluation.failureCode || 'RESULT_MAPPING_FAILED',
        evaluation.failureMessage || 'Adapter 归一化失败',
      )
    }
  }
  if (!evaluation.completionDigest && !ACTIVE_STATUSES.has(evaluation.status)) {
    throw new BenchmarkProtocolError('EVALUATION_NOT_ACTIVE', '评测 Run 已不接受终态回调', 409)
  }
  const referencedArtifacts = evaluation.artifacts.filter((artifact: StoredEvaluationArtifact) => (
    input.completion.evidenceArtifactIds.includes(artifact.id)
  ))
  if (referencedArtifacts.length !== input.completion.evidenceArtifactIds.length) {
    throw new BenchmarkProtocolError('EVALUATION_EVIDENCE_MISMATCH', '评测终态引用了无效证据 Artifact', 422)
  }
  const rawResultJson = canonicalJson(input.completion.rawResult)
  if (!evaluation.completionDigest) {
    const claimed = await prisma.benchmarkEvaluation.updateMany({
      where: {
        id: input.evaluationId,
        completionDigest: null,
        status: { in: [...ACTIVE_STATUSES] },
      },
      data: {
        status: 'normalizing',
        rawResultJson,
        rawResultDigest: fingerprintJson(input.completion.rawResult),
        runtimeFactsJson: canonicalJson(input.completion.runtimeFacts),
        cleanupJson: canonicalJson(input.completion.cleanup),
        completionDigest,
        failureCode: input.completion.error?.code || null,
        failureMessage: input.completion.error?.message || null,
        lastProgressAt: new Date(),
      },
    })
    if (claimed.count !== 1) return completeBenchmarkEvaluation(input)
  } else {
    const resumed = await prisma.benchmarkEvaluation.updateMany({
      where: {
        id: input.evaluationId,
        completionDigest,
        status: { in: ['normalizing', 'normalization_failed'] },
      },
      data: { status: 'normalizing', lastProgressAt: new Date() },
    })
    if (resumed.count !== 1) return completeBenchmarkEvaluation(input)
  }

  evaluation = await evaluationOrThrow(input.evaluationId)
  let normalized: NormalizedBenchmarkResult
  try {
    const adapter = getBenchmarkAdapter(evaluation.adapterKey)
    const evaluationJob = frozenEvaluationJob(evaluation.requestJson)
    normalized = adapter.normalizeResult({
      evaluationId: evaluation.id,
      evaluatorKey: evaluation.evaluatorKey,
      evaluationJob,
      completion: input.completion,
      evidenceArtifacts: await normalizedEvidenceArtifacts(referencedArtifacts),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Adapter 归一化失败'
    const failure = normalizationFailure(error)
    const failureCode = failure.code
    const failedResult: NormalizedBenchmarkResult = {
      status: 'failed',
      summary: message,
      score: null,
      points: [],
      evidence: {
        artifactIds: referencedArtifacts.map((artifact: StoredEvaluationArtifact) => artifact.id),
        cleanup: input.completion.cleanup,
      },
      nativeMetrics: {},
      errorMessage: message,
    }
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const finalized = await tx.benchmarkEvaluation.updateMany({
          where: {
            id: input.evaluationId,
            status: 'normalizing',
            completionDigest,
          },
          data: {
            status: 'normalization_failed',
            failureCode,
            failureMessage: message,
            finishedAt: new Date(),
            continuationStatus: 'pending',
            continuationTriedAt: null,
            continuationError: null,
          },
        })
        if (finalized.count !== 1) throw finalizationLostError()
        await tx.benchmarkCaseRun.update({
          where: { id: evaluation.caseRunId },
          data: {
            status: 'evaluation_failed',
            failureCode,
            failureMessage: message,
            finishedAt: new Date(),
          },
        })
        await writeExperimentResult({ tx, evaluation, normalized: failedResult })
      })
    } catch (persistenceError) {
      if (isFinalizationLost(persistenceError)) throw persistenceError
      return recordPersistenceFailure(input.evaluationId, persistenceError)
    }
    scheduleBenchmarkEvaluationContinuation(evaluation.id)
    throw nonRetryableNormalizationError(failureCode, message, failure.category)
  }

  const evaluationStatus = normalized.status === 'failed'
    ? 'failed'
    : input.completion.status === 'submission_invalid'
      ? 'submission_invalid'
      : 'completed'
  const caseRunStatus = normalized.status === 'failed'
    ? 'evaluation_failed'
    : input.completion.status === 'submission_invalid'
      ? 'submission_invalid'
      : 'evaluated'
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const finalized = await tx.benchmarkEvaluation.updateMany({
        where: {
          id: evaluation.id,
          status: 'normalizing',
          completionDigest,
        },
        data: {
          status: evaluationStatus,
          normalizedResultJson: canonicalJson(normalized as unknown as JsonValue),
          failureCode: input.completion.error?.code || null,
          failureMessage: input.completion.error?.message || null,
          finishedAt: new Date(),
          continuationStatus: 'pending',
          continuationTriedAt: null,
          continuationError: null,
        },
      })
      if (finalized.count !== 1) throw finalizationLostError()
      await tx.benchmarkCaseRun.update({
        where: { id: evaluation.caseRunId },
        data: {
          status: caseRunStatus,
          failureCode: input.completion.status === 'completed'
            ? null
            : input.completion.error?.code || 'EVALUATION_FAILED',
          failureMessage: input.completion.status === 'completed'
            ? null
            : input.completion.error?.message || normalized.errorMessage || normalized.summary,
          finishedAt: new Date(),
        },
      })
      await writeExperimentResult({ tx, evaluation, normalized })
    })
  } catch (error) {
    if (isFinalizationLost(error)) throw error
    return recordPersistenceFailure(input.evaluationId, error)
  }
  scheduleBenchmarkEvaluationContinuation(evaluation.id)
  return {
    accepted: true,
    evaluationStatus,
    normalizationStatus: 'completed',
    normalizedResult: normalized,
  }
}
