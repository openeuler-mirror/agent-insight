/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Prisma } from '@prisma/client'

import type { AgentTaskEnvelope, JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { canonicalJson } from '../../../packages/benchmark-protocol/src/contracts'
import {
  benchmarkEvaluationDispatchDigest,
  type ArtifactDescriptor,
  type BenchmarkEvaluationDispatchRequest,
  type ReadonlySubmissionArtifact,
} from '../../../packages/benchmark-protocol/src/evaluation-contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { resolveAgentInsightDataPath } from '@/lib/env'
import { prisma } from '@/lib/storage/prisma'

import { getBenchmarkAdapter } from './adapter-registry'
import { dispatchBenchmarkEvaluation } from './evaluation-scheduler'
import { refreshBenchmarkImagePreparation } from './image-preparation'

function parseJson<T>(value: string | null, code: string): T {
  if (!value) throw new BenchmarkProtocolError(code, '评测所需的冻结数据不存在', 409)
  try {
    return JSON.parse(value) as T
  } catch {
    throw new BenchmarkProtocolError(code, '评测所需的冻结数据损坏', 500)
  }
}

function storedArtifactPath(storagePath: string): string {
  if (path.isAbsolute(storagePath)) {
    throw new BenchmarkProtocolError('ARTIFACT_STORAGE_PATH_INVALID', 'Artifact 存储路径不合法', 500)
  }
  const root = path.resolve(resolveAgentInsightDataPath())
  const resolved = path.resolve(root, storagePath)
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new BenchmarkProtocolError('ARTIFACT_STORAGE_PATH_INVALID', 'Artifact 存储路径越界', 500)
  }
  return resolved
}

export function benchmarkArtifactAbsolutePath(storagePath: string): string {
  return storedArtifactPath(storagePath)
}

type StoredSubmissionRun = {
  id: string
  submissionSource: string
  taskEnvelopeJson: string | null
  submissionContractJson: string | null
  publicPayloadJson: string | null
  privatePayloadJson: string | null
  artifacts: Array<{ id: string; name: string; mediaType: string; sha256: string; sizeBytes: number; storagePath: string }>
  adapterKey: string
}

async function readValidatedSubmission(run: StoredSubmissionRun) {
  const imported = run.submissionSource === 'imported'
  const task = imported ? undefined : parseJson<AgentTaskEnvelope>(run.taskEnvelopeJson, 'RUN_TASK_MISSING')
  const publicPayload = parseJson<JsonValue>(run.publicPayloadJson, 'RUN_PUBLIC_PAYLOAD_MISSING')
  const privatePayload = parseJson<JsonValue>(run.privatePayloadJson, 'RUN_PRIVATE_PAYLOAD_MISSING')
  const adapter = getBenchmarkAdapter(run.adapterKey)
  const currentContract = canonicalJson(adapter.manifest.requiredArtifacts as unknown as JsonValue)
  const legacyZsoftImportContract = run.adapterKey === 'zsoft-l1'
    ? canonicalJson(adapter.manifest.requiredArtifacts.map(item => ({ ...item, collector: 'imported-submission/v1' })) as unknown as JsonValue)
    : undefined
  if (imported && run.submissionContractJson !== currentContract && run.submissionContractJson !== legacyZsoftImportContract) {
    throw new BenchmarkProtocolError('SUBMISSION_CONTRACT_CHANGED', '历史提交契约已变更，无法继续评测', 409)
  }
  const artifactReaders: ReadonlySubmissionArtifact[] = run.artifacts.map((artifact: {
    id: string
    name: string
    mediaType: string
    sha256: string
    sizeBytes: number
    storagePath: string
  }) => {
    const descriptor: ArtifactDescriptor = {
      artifactId: artifact.id,
      executionRunId: run.id,
      name: artifact.name,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256 as `sha256:${string}`,
      sizeBytes: artifact.sizeBytes,
    }
    let cached: Uint8Array | undefined
    return {
      descriptor,
      async readBytes() {
        if (!cached) {
          try { cached = new Uint8Array(await fs.readFile(storedArtifactPath(artifact.storagePath))) }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            throw new BenchmarkProtocolError('ARTIFACT_CONTENT_MISSING', '提交物文件不存在', 409)
          }
        }
        return cached
      },
    }
  })
  try {
    await adapter.validateSubmission(task
      ? { task, artifacts: artifactReaders }
      : { submission: { runId: run.id, publicPayload, privatePayload }, artifacts: artifactReaders })
  } catch (error) {
    if (error instanceof BenchmarkProtocolError) {
      throw new BenchmarkProtocolError(
        error.code,
        error.message,
        error.httpStatus,
        error.retryable,
        { ...error.details, phase: 'submission-validation' },
      )
    }
    throw error
  }

  return { task, publicPayload, privatePayload, adapter, artifactReaders }
}

export async function prepareBenchmarkEvaluation(
  executionRunId: string,
  options: { forceNewAttempt?: boolean; retryOfEvaluationId?: string } = {},
): Promise<{
  evaluationRunId: string
  status: string
  created: boolean
}> {
  const latest = await prisma.benchmarkEvaluation.findFirst({
    where: { caseRunId: executionRunId },
    orderBy: { attemptNo: 'desc' },
  })
  const attemptNo = options.forceNewAttempt ? (latest?.attemptNo || 0) + 1 : 1
  if (!options.forceNewAttempt && latest?.attemptNo === 1) {
    return { evaluationRunId: latest.id, status: latest.status, created: false }
  }
  const run = await prisma.benchmarkCaseRun.findUnique({
    where: { id: executionRunId },
    include: {
      artifacts: { orderBy: { createdAt: 'asc' } },
      experiment: { include: { benchmarkBinding: true } },
    },
  })
  if (!run) throw new BenchmarkProtocolError('RUN_NOT_FOUND', 'Benchmark Run 不存在', 404)
  if (run.status !== 'submitted') {
    throw new BenchmarkProtocolError('RUN_NOT_SUBMITTED', '只有 submitted Run 可以生成评测任务', 409)
  }
  const binding = run.experiment.benchmarkBinding
  if (!binding || binding.adapterKey !== run.adapterKey) {
    throw new BenchmarkProtocolError('BENCHMARK_EVALUATION_SNAPSHOT_MISSING', '实验评测快照不存在或 Adapter 不一致', 409)
  }
  const { task, publicPayload, privatePayload, adapter, artifactReaders } = await readValidatedSubmission(run)

  const evaluationRunId = `veval_${randomUUID().replaceAll('-', '')}`
  const defaults = adapter.manifest.evaluation
  const job = adapter.buildEvaluationRequest({
    context: {
      evaluationRunId,
      executionRunId: run.id,
      experimentId: run.experimentId,
      caseId: run.experimentCaseId,
      datasetContentHash: binding.datasetContentHash,
    },
    publicPayload,
    privatePayload,
    artifacts: artifactReaders.map((item) => item.descriptor),
    runConfig: {
      evaluatorKey: defaults.evaluatorKey,
      timeoutSeconds: defaults.defaultTimeoutSeconds,
      cpu: defaults.defaultResources.cpu,
      memoryMiB: defaults.defaultResources.memoryMiB,
      agentModel: task ? task.agentConfig.model || `${task.agentConfig.platform}/${task.agentConfig.agent}` : undefined,
    },
  })
  const configuredPlatformBaseUrl = String(binding.callbackOrigin || '').trim()
  if (!configuredPlatformBaseUrl) {
    throw new BenchmarkProtocolError('BENCHMARK_PUBLIC_BASE_URL_MISSING', '缺少 Agent Insight 对外地址', 500)
  }
  let platformUrl: URL
  try {
    platformUrl = new URL(configuredPlatformBaseUrl)
  } catch {
    throw new BenchmarkProtocolError('BENCHMARK_PUBLIC_BASE_URL_INVALID', 'Agent Insight 对外地址不合法', 500)
  }
  if (
    !['http:', 'https:'].includes(platformUrl.protocol)
    || platformUrl.username
    || platformUrl.password
    || platformUrl.search
    || platformUrl.hash
  ) {
    throw new BenchmarkProtocolError('BENCHMARK_PUBLIC_BASE_URL_INVALID', 'Agent Insight 对外地址必须是无凭证、query 和 fragment 的 HTTP(S) URL', 500)
  }
  const platformBaseUrl = platformUrl.toString().replace(/\/$/, '')
  const callbackBaseUrl = `${platformBaseUrl}/api/benchmark/v1/evaluations/${encodeURIComponent(evaluationRunId)}`
  const digestInput = {
    runId: evaluationRunId,
    evaluationJob: job,
    platformBaseUrl,
    callbackBaseUrl,
    timeoutSeconds: defaults.defaultTimeoutSeconds,
  }
  const requestDigest = benchmarkEvaluationDispatchDigest(digestInput)
  const request: BenchmarkEvaluationDispatchRequest = { ...digestInput, requestDigest }
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.benchmarkEvaluation.create({
        data: {
          id: evaluationRunId,
          caseRunId: run.id,
          attemptNo,
          retryOfEvaluationId: options.retryOfEvaluationId || null,
          status: 'queued',
          adapterKey: run.adapterKey,
          evaluatorKey: defaults.evaluatorKey,
          requestJson: canonicalJson(job as unknown as JsonValue),
          requestDigest,
          callbackBaseUrl,
          timeoutSeconds: defaults.defaultTimeoutSeconds,
        },
      })
      await tx.benchmarkEvaluationDispatchOutbox.create({
        data: {
          evaluationId: evaluationRunId,
          requestJson: canonicalJson(request as unknown as JsonValue),
          requestDigest,
        },
      })
    })
  } catch (error) {
    const concurrent = await prisma.benchmarkEvaluation.findFirst({
      where: { caseRunId: executionRunId, attemptNo },
    })
    if (concurrent) {
      return { evaluationRunId: concurrent.id, status: concurrent.status, created: false }
    }
    throw error
  }
  return { evaluationRunId, status: 'queued', created: true }
}

const REEVALUATION_LOCK = Symbol.for('agent-insight.benchmark.reevaluation-lock')

function reevaluationLocks(): Set<string> {
  const state = globalThis as typeof globalThis & { [REEVALUATION_LOCK]?: Set<string> }
  if (!state[REEVALUATION_LOCK]) state[REEVALUATION_LOCK] = new Set<string>()
  return state[REEVALUATION_LOCK]
}

export async function retryBenchmarkEvaluation(input: {
  experimentId: string
  resultId: string
  user: string
}): Promise<{ status: 'running'; evaluationRunId: string }> {
  const lock = reevaluationLocks()
  const result = await prisma.experimentEvalResult.findFirst({
    where: {
      id: input.resultId,
      experimentId: input.experimentId,
      case: { experiment: { user: input.user, scope: 'benchmark' } },
    },
    select: { caseId: true, evaluatorId: true },
  })
  if (!result?.evaluatorId.startsWith('benchmark:')) {
    throw new BenchmarkProtocolError('BENCHMARK_RESULT_NOT_FOUND', 'Benchmark 评测结果不存在', 404)
  }

  const lockKey = `${input.experimentId}:${result.caseId}`
  if (lock.has(lockKey)) {
    throw new BenchmarkProtocolError('BENCHMARK_REEVALUATION_BUSY', '当前 Case 已有 Benchmark 重评正在执行', 409)
  }
  lock.add(lockKey)
  try {
    const run = await prisma.benchmarkCaseRun.findFirst({
      where: { experimentId: input.experimentId, experimentCaseId: result.caseId },
      orderBy: { createdAt: 'desc' },
      include: {
        evaluations: { orderBy: { attemptNo: 'desc' }, take: 1 },
        artifacts: true,
      },
    })
    if (run && (run.status === 'submitted' || ['queued', 'dispatch_unknown', 'running_evaluator', 'normalizing'].includes(run.evaluations[0]?.status))) {
      throw new BenchmarkProtocolError('BENCHMARK_REEVALUATION_BUSY', '当前 Case 正在执行或评测，请稍后重评', 409)
    }
    const requiredNames = run
      ? getBenchmarkAdapter(run.adapterKey).manifest.requiredArtifacts.map((artifact) => artifact.name)
      : []
    const submittedNames = new Set(run?.artifacts.map((artifact: { name: string }) => artifact.name) || [])
    if (
      !run
      || requiredNames.some((name) => !submittedNames.has(name))
      || !['evaluated', 'evaluation_failed'].includes(run.status)
    ) {
      throw new BenchmarkProtocolError('BENCHMARK_SUBMISSION_NOT_READY', '当前 Case 没有可复用的有效提交物', 409)
    }
    if (run.evaluations[0]?.continuationStatus !== 'completed') {
      throw new BenchmarkProtocolError(
        'BENCHMARK_REEVALUATION_BUSY',
        '当前 Benchmark 结果仍在收敛，请稍后重评',
        409,
      )
    }

    await readValidatedSubmission(run)

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const claimed = await tx.benchmarkCaseRun.updateMany({
        where: { id: run.id, status: run.status, updatedAt: run.updatedAt },
        data: { status: 'submitted', failureCode: null, failureMessage: null },
      })
      if (claimed.count !== 1) {
        throw new BenchmarkProtocolError('BENCHMARK_REEVALUATION_BUSY', '当前 Case 已有 Benchmark 重评正在执行', 409)
      }
      await tx.experimentEvalResult.update({
        where: { id: input.resultId },
        data: {
          status: 'pending',
          verdict: null,
          summary: null,
          score: null,
          pointsJson: null,
          evidenceJson: null,
          errorMessage: null,
          durationMs: null,
          humanScore: null,
          humanReason: null,
          humanBy: null,
          humanAt: null,
        },
      })
      await tx.experiment.update({
        where: { id: input.experimentId },
        data: { status: 'running' },
      })
      await tx.benchmarkExperimentBinding.update({
        where: { experimentId: input.experimentId },
        data: { schedulerStatus: 'running' },
      })
    })
    const prepared = await prepareBenchmarkEvaluation(run.id, {
      forceNewAttempt: true,
      retryOfEvaluationId: run.evaluations[0]?.id,
    })
    void refreshBenchmarkImagePreparation()
      .catch((error) => console.warn('[benchmark/image-pool]', error))
      .then(() => dispatchBenchmarkEvaluation(prepared.evaluationRunId))
      .catch((error) => {
        console.error('[benchmark/reevaluation] dispatch failed', error)
      })
    return { status: 'running', evaluationRunId: prepared.evaluationRunId }
  } finally {
    lock.delete(lockKey)
  }
}
