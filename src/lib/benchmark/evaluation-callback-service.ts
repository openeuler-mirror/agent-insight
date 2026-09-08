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
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { resolveAgentInsightDataPath } from '@/lib/env'
import { prisma } from '@/lib/storage/prisma'

import { getBenchmarkAdapter } from './adapter-registry'
import { finalizeBenchmarkCase } from './experiment-lifecycle'

const ACTIVE_STATUSES = new Set(['queued', 'dispatch_unknown', 'running_evaluator'])
const TERMINAL_CASE_STATUSES = [
  'evaluated',
  'evaluation_failed',
  'submission_invalid',
  'execution_failed',
  'dispatch_failed',
] as const
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024

type StoredEvaluationArtifact = {
  id: string
  evaluationId: string
  name: string
  kind: string
  mediaType: string
  sha256: string
  sizeBytes: number
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
  await prisma.benchmarkEvaluation.update({
    where: { id: input.evaluationId },
    data: {
      status: 'running_evaluator',
      progressJson: canonicalJson(input.progress as unknown as JsonValue),
      lastProgressAt: new Date(input.progress.occurredAt),
      startedAt: evaluation.startedAt || new Date(),
    },
  })
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
    || value.evidenceArtifactIds.length < 1
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

async function settleExperimentIfComplete(
  tx: Prisma.TransactionClient,
  experimentId: string,
): Promise<void> {
  const binding = await tx.benchmarkExperimentBinding.findUnique({
    where: { experimentId },
    select: { expectedCaseCount: true },
  })
  if (!binding) {
    throw new BenchmarkProtocolError('BENCHMARK_BINDING_NOT_FOUND', 'Benchmark 实验绑定不存在', 500, true)
  }
  const runs = await tx.benchmarkCaseRun.findMany({
    where: { experimentId },
    orderBy: { createdAt: 'desc' },
    select: { experimentCaseId: true, status: true },
  })
  const latestRunStatus = new Map<string, string>()
  for (const run of runs) {
    if (!latestRunStatus.has(run.experimentCaseId)) latestRunStatus.set(run.experimentCaseId, run.status)
  }
  const terminalCount = Array.from(latestRunStatus.values())
    .filter((status) => (TERMINAL_CASE_STATUSES as readonly string[]).includes(status)).length
  if (terminalCount !== binding.expectedCaseCount) return
  const pendingResultCount = await tx.experimentEvalResult.count({
    where: { experimentId, status: { in: ['pending', 'running'] } },
  })
  if (pendingResultCount > 0) return
  await tx.experiment.update({
    where: { id: experimentId },
    data: { status: 'done' },
  })
  await tx.benchmarkExperimentBinding.update({
    where: { experimentId },
    data: { schedulerStatus: 'done' },
  })
}

function normalizationFailureCode(error: unknown): 'RAW_RESULT_SCHEMA_INVALID' | 'RESULT_MAPPING_FAILED' {
  return error instanceof BenchmarkProtocolError
    && ['RAW_RESULT_SCHEMA_INVALID', 'SWE_RAW_RESULT_INVALID'].includes(error.code)
    ? 'RAW_RESULT_SCHEMA_INVALID'
    : 'RESULT_MAPPING_FAILED'
}

function nonRetryableNormalizationError(code: string, message: string): BenchmarkProtocolError {
  return new BenchmarkProtocolError(code, message, 422, false, {
    acceptedRawResult: true,
    evaluationStatus: 'normalization_failed',
  })
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
    if (evaluation.status !== 'normalization_failed') {
      return {
        accepted: true,
        evaluationStatus: evaluation.status,
        normalizationStatus: 'completed',
        ...(evaluation.normalizedResultJson
          ? { normalizedResult: JSON.parse(evaluation.normalizedResultJson) as NormalizedBenchmarkResult }
          : {}),
      }
    }
    if (evaluation.failureCode !== 'RESULT_PERSISTENCE_FAILED') {
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
      where: { id: input.evaluationId, completionDigest: null },
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
    await prisma.benchmarkEvaluation.update({
      where: { id: input.evaluationId },
      data: { status: 'normalizing' },
    })
  }

  evaluation = await evaluationOrThrow(input.evaluationId)
  let normalized: NormalizedBenchmarkResult
  try {
    const adapter = getBenchmarkAdapter(evaluation.adapterKey)
    normalized = adapter.normalizeResult({
      evaluationId: evaluation.id,
      evaluatorKey: evaluation.evaluatorKey,
      completion: input.completion,
      evidenceArtifacts: referencedArtifacts.map((artifact: StoredEvaluationArtifact) => ({
        artifactId: artifact.id,
        evaluationId: artifact.evaluationId,
        name: artifact.name,
        kind: artifact.kind,
        mediaType: artifact.mediaType,
        sha256: artifact.sha256 as `sha256:${string}`,
        sizeBytes: artifact.sizeBytes,
      })),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Adapter 归一化失败'
    const failureCode = normalizationFailureCode(error)
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
        await tx.benchmarkEvaluation.update({
          where: { id: input.evaluationId },
          data: {
            status: 'normalization_failed',
            failureCode,
            failureMessage: message,
            finishedAt: new Date(),
          },
        })
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
        await settleExperimentIfComplete(tx, evaluation.caseRun.experimentId)
      })
    } catch (persistenceError) {
      return recordPersistenceFailure(input.evaluationId, persistenceError)
    }
    void finalizeBenchmarkCase({
      caseRunId: evaluation.caseRunId,
      runSupplementalEvaluators: evaluation.attemptNo === 1,
      continueCases: evaluation.attemptNo === 1,
    }).catch((continuationError) => {
      console.error('[benchmark/evaluation-callback] failure continuation failed', continuationError)
    })
    throw nonRetryableNormalizationError(failureCode, message)
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
      await tx.benchmarkEvaluation.update({
        where: { id: evaluation.id },
        data: {
          status: evaluationStatus,
          normalizedResultJson: canonicalJson(normalized as unknown as JsonValue),
          finishedAt: new Date(),
        },
      })
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
      await settleExperimentIfComplete(tx, evaluation.caseRun.experimentId)
    })
    void finalizeBenchmarkCase({
      caseRunId: evaluation.caseRunId,
      runSupplementalEvaluators: evaluation.attemptNo === 1,
      continueCases: evaluation.attemptNo === 1,
    }).catch((continuationError) => {
      console.error('[benchmark/evaluation-callback] continuation failed', continuationError)
    })
    return {
      accepted: true,
      evaluationStatus,
      normalizationStatus: 'completed',
      normalizedResult: normalized,
    }
  } catch (error) {
    return recordPersistenceFailure(input.evaluationId, error)
  }
}
