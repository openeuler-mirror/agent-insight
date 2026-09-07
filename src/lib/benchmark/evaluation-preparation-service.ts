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

export async function prepareBenchmarkEvaluation(executionRunId: string): Promise<{
  evaluationRunId: string
  status: string
  created: boolean
}> {
  const existing = await prisma.benchmarkEvaluation.findFirst({
    where: { caseRunId: executionRunId, attemptNo: 1 },
  })
  if (existing) {
    return { evaluationRunId: existing.id, status: existing.status, created: false }
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
  const task = parseJson<AgentTaskEnvelope>(run.taskEnvelopeJson, 'RUN_TASK_MISSING')
  const publicPayload = parseJson<JsonValue>(run.publicPayloadJson, 'RUN_PUBLIC_PAYLOAD_MISSING')
  const privatePayload = parseJson<JsonValue>(run.privatePayloadJson, 'RUN_PRIVATE_PAYLOAD_MISSING')
  const adapter = getBenchmarkAdapter(run.adapterKey)
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
        if (!cached) cached = new Uint8Array(await fs.readFile(storedArtifactPath(artifact.storagePath)))
        return cached
      },
    }
  })
  await adapter.validateSubmission({ task, artifacts: artifactReaders })

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
      agentModel: task.agentConfig.model || `${task.agentConfig.platform}/${task.agentConfig.agent}`,
    },
  })
  const configuredPlatformBaseUrl = String(
    binding.callbackOrigin || process.env.AGENT_INSIGHT_PUBLIC_BASE_URL || '',
  ).trim()
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
          attemptNo: 1,
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
      where: { caseRunId: executionRunId, attemptNo: 1 },
    })
    if (concurrent) {
      return { evaluationRunId: concurrent.id, status: concurrent.status, created: false }
    }
    throw error
  }
  return { evaluationRunId, status: 'queued', created: true }
}
