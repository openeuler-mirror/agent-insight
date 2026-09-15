import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { AgentTaskEnvelope, JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { canonicalJson, fingerprintJson } from '../../../packages/benchmark-protocol/src/contracts'
import type {
  BenchmarkExecutionCompletion,
  BenchmarkExecutionProgress,
} from '../../../packages/benchmark-protocol/src/executor-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { resolveAgentInsightDataPath } from '@/lib/env'
import { prisma } from '@/lib/storage/prisma'

import { dispatchBenchmarkEvaluation } from './evaluation-scheduler'
import { prepareBenchmarkEvaluation } from './evaluation-preparation-service'
import { failBenchmarkCaseResults } from './experiment-lifecycle'

const ACTIVE_STATUSES = new Set([
  'dispatching',
  'dispatch_unknown',
  'running_agent',
  'collecting',
  'uploading',
  'cleaning',
])

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

async function ownedRun(runId: string, clientId: string) {
  const run = await prisma.benchmarkCaseRun.findUnique({
    where: { id: runId },
    include: { artifacts: true },
  })
  if (!run) throw new BenchmarkProtocolError('RUN_NOT_FOUND', 'Benchmark Run 不存在', 404)
  if (run.clientId !== clientId) {
    throw new BenchmarkProtocolError('RUN_CLIENT_MISMATCH', 'Run 不属于当前执行器', 403)
  }
  return run
}

function taskContract(run: { taskEnvelopeJson: string | null }) {
  if (!run.taskEnvelopeJson) {
    throw new BenchmarkProtocolError('RUN_TASK_MISSING', 'Run 缺少已冻结任务', 409)
  }
  let task: AgentTaskEnvelope
  try {
    task = JSON.parse(run.taskEnvelopeJson) as AgentTaskEnvelope
  } catch {
    throw new BenchmarkProtocolError('RUN_TASK_INVALID', 'Run 任务快照损坏', 500)
  }
  return task.submission.requiredArtifacts
}

export async function recordBenchmarkRunProgress(input: {
  runId: string
  clientId: string
  progress: BenchmarkExecutionProgress
}): Promise<{ accepted: true; desiredState: 'continue' }> {
  const run = await ownedRun(input.runId, input.clientId)
  if (!ACTIVE_STATUSES.has(run.status)) {
    throw new BenchmarkProtocolError('RUN_NOT_ACTIVE', 'Run 已不接受进度回调', 409)
  }
  const allowedStages = new Set(['preparing', 'agent_running', 'collecting', 'uploading', 'cleaning'])
  if (
    !input.progress
    || typeof input.progress !== 'object'
    || input.progress.kind !== 'execution'
    || !allowedStages.has(input.progress.stage)
    || !Number.isFinite(Date.parse(input.progress.occurredAt))
  ) {
    throw new BenchmarkProtocolError('PROGRESS_INVALID', '执行进度格式不合法', 400)
  }
  const status = ['collecting', 'uploading', 'cleaning'].includes(input.progress.stage)
    ? input.progress.stage
    : 'running_agent'
  const rank = new Map([
    ['dispatching', 0],
    ['dispatch_unknown', 0],
    ['running_agent', 1],
    ['collecting', 2],
    ['uploading', 3],
    ['cleaning', 4],
  ])
  if ((rank.get(status) || 0) < (rank.get(run.status) || 0)) {
    return { accepted: true, desiredState: 'continue' }
  }
  const updated = await prisma.benchmarkCaseRun.updateMany({
    where: { id: input.runId, status: run.status },
    data: {
      status,
      progressJson: canonicalJson(input.progress as unknown as JsonValue),
      lastProgressAt: new Date(),
    },
  })
  if (updated.count !== 1) return recordBenchmarkRunProgress(input)
  return { accepted: true, desiredState: 'continue' }
}

export async function storeBenchmarkArtifact(input: {
  runId: string
  clientId: string
  name: string
  mediaType: string
  expectedSha256: string
  bytes: Uint8Array
}): Promise<{ artifactId: string; sha256: string; size: number }> {
  const run = await ownedRun(input.runId, input.clientId)
  if (!ACTIVE_STATUSES.has(run.status) && run.status !== 'submitted') {
    throw new BenchmarkProtocolError('RUN_NOT_ACTIVE', 'Run 已不接受 Artifact', 409)
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.name)) {
    throw new BenchmarkProtocolError('ARTIFACT_NAME_INVALID', 'Artifact 名称不合法', 400)
  }
  const contract = taskContract(run).find((item) => item.name === input.name)
  if (!contract || contract.mediaType !== input.mediaType) {
    throw new BenchmarkProtocolError('ARTIFACT_CONTRACT_MISMATCH', 'Artifact 不符合任务契约', 422)
  }
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > contract.maxBytes) {
    throw new BenchmarkProtocolError('ARTIFACT_SIZE_INVALID', 'Artifact 为空或超过大小上限', 422)
  }
  const digest = sha256(input.bytes)
  if (digest !== input.expectedSha256) {
    throw new BenchmarkProtocolError('ARTIFACT_DIGEST_MISMATCH', 'Artifact SHA-256 不匹配', 422)
  }
  const existing = run.artifacts.find((item: { name: string }) => item.name === input.name)
  if (existing) {
    if (
      existing.sha256 !== digest
      || existing.mediaType !== input.mediaType
      || existing.sizeBytes !== input.bytes.byteLength
    ) {
      throw new BenchmarkProtocolError('ARTIFACT_CONFLICT', '同名 Artifact 内容冲突', 409)
    }
    return { artifactId: existing.id, sha256: existing.sha256, size: existing.sizeBytes }
  }

  const artifactId = `bart_${randomUUID().replaceAll('-', '')}`
  const relativePath = path.join('benchmark-artifacts', input.runId, `${artifactId}-${input.name}`)
  const absolutePath = resolveAgentInsightDataPath(relativePath)
  await fs.mkdir(path.dirname(absolutePath), { recursive: true, mode: 0o700 })
  const tempPath = `${absolutePath}.${process.pid}.tmp`
  await fs.writeFile(tempPath, input.bytes, { mode: 0o600 })
  await fs.rename(tempPath, absolutePath)
  try {
    await prisma.benchmarkArtifact.create({
      data: {
        id: artifactId,
        runId: input.runId,
        name: input.name,
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
  await prisma.benchmarkCaseRun.updateMany({
    where: { id: input.runId, status: { in: ['running_agent', 'collecting', 'uploading'] } },
    data: { status: 'uploading', lastProgressAt: new Date() },
  })
  return { artifactId, sha256: digest, size: input.bytes.byteLength }
}

export async function completeBenchmarkRun(input: {
  runId: string
  clientId: string
  completion: BenchmarkExecutionCompletion
}): Promise<{ accepted: true; status: string; evaluationRunId?: string }> {
  const run = await ownedRun(input.runId, input.clientId)
  if (
    !input.completion
    || typeof input.completion !== 'object'
    || Array.isArray(input.completion)
  ) {
    throw new BenchmarkProtocolError('RUN_COMPLETION_INVALID', 'Run 终态格式不合法', 400)
  }
  const completionDigest = fingerprintJson(input.completion as unknown as JsonValue)
  if (run.completionDigest) {
    if (run.completionDigest !== completionDigest) {
      throw new BenchmarkProtocolError('RUN_COMPLETION_CONFLICT', 'Run 终态内容冲突', 409)
    }
    if (run.status === 'execution_failed') {
      await failBenchmarkCaseResults(
        run.id,
        run.failureMessage || input.completion.error?.message || 'Agent 执行失败，未生成可评测的 Patch',
      )
      return { accepted: true, status: run.status }
    }
    const evaluation = await prisma.benchmarkEvaluation.findFirst({
      where: { caseRunId: input.runId, attemptNo: 1 },
    })
    if (evaluation && ['queued', 'dispatch_unknown'].includes(evaluation.status)) {
      void dispatchBenchmarkEvaluation(evaluation.id).catch((error) => {
        console.error('[benchmark/run-callback] evaluation redispatch failed', error)
      })
    }
    return {
      accepted: true,
      status: run.status,
      ...(evaluation ? { evaluationRunId: evaluation.id } : {}),
    }
  }
  if (!ACTIVE_STATUSES.has(run.status)) {
    throw new BenchmarkProtocolError('RUN_NOT_ACTIVE', 'Run 已不接受终态回调', 409)
  }
  if (
    input.completion.kind !== 'execution'
    || !['succeeded', 'failed'].includes(input.completion.status)
    || !Array.isArray(input.completion.artifacts)
    || !input.completion.runFacts
    || typeof input.completion.runFacts !== 'object'
    || Array.isArray(input.completion.runFacts)
    || !input.completion.cleanup
    || typeof input.completion.cleanup !== 'object'
    || Array.isArray(input.completion.cleanup)
  ) {
    throw new BenchmarkProtocolError('RUN_COMPLETION_INVALID', 'Run 终态格式不合法', 400)
  }
  const artifactById = new Map<string, {
    id: string
    name: string
    sha256: string
  }>(run.artifacts.map((item: { id: string; name: string; sha256: string }) => [item.id, item]))
  for (const ref of input.completion.artifacts || []) {
    const artifact = artifactById.get(ref.artifactId)
    if (!artifact || artifact.name !== ref.name || artifact.sha256 !== ref.sha256) {
      throw new BenchmarkProtocolError('RUN_ARTIFACT_MISMATCH', 'Run 终态引用了无效 Artifact', 422)
    }
  }
  if (input.completion.status === 'succeeded') {
    const required = taskContract(run)
    const submittedNames = new Set(input.completion.artifacts.map((item) => item.name))
    if (required.some((item) => !submittedNames.has(item.name))) {
      throw new BenchmarkProtocolError('RUN_ARTIFACT_MISSING', 'Run 缺少必需 Artifact', 422)
    }
  }
  const status = input.completion.status === 'succeeded' ? 'submitted' : 'execution_failed'
  const updated = await prisma.benchmarkCaseRun.updateMany({
    where: {
      id: input.runId,
      completionDigest: null,
      status: { in: [...ACTIVE_STATUSES] },
    },
    data: {
      status,
      runFactsJson: canonicalJson(input.completion.runFacts as JsonValue),
      cleanupJson: canonicalJson(input.completion.cleanup as JsonValue),
      completionDigest,
      failureCode: input.completion.error?.code || null,
      failureMessage: input.completion.error?.message || null,
      lastProgressAt: new Date(),
      finishedAt: new Date(),
    },
  })
  if (updated.count !== 1) {
    return completeBenchmarkRun(input)
  }
  if (status !== 'submitted') {
    await failBenchmarkCaseResults(
      input.runId,
      input.completion.error?.message || 'Agent 执行失败，未生成可评测的 Patch',
    )
    return { accepted: true, status }
  }
  try {
    const prepared = await prepareBenchmarkEvaluation(input.runId)
    void dispatchBenchmarkEvaluation(prepared.evaluationRunId).catch((error) => {
      console.error('[benchmark/run-callback] evaluation dispatch failed', error)
    })
    return {
      accepted: true,
      status,
      evaluationRunId: prepared.evaluationRunId,
    }
  } catch (error) {
    if (
      !(error instanceof BenchmarkProtocolError)
      || (!error.code.startsWith('ARTIFACT_') && !error.code.startsWith('SWE_PATCH_'))
    ) throw error
    await prisma.benchmarkCaseRun.update({
      where: { id: input.runId },
      data: {
        status: 'submission_invalid',
        failureCode: error.code,
        failureMessage: error.message,
      },
    })
    void failBenchmarkCaseResults(input.runId, error.message).catch((continuationError) => {
      console.error('[benchmark/run-callback] invalid submission continuation failed', continuationError)
    })
    return { accepted: true, status: 'submission_invalid' }
  }
}
