import { parseExecutionConcurrency } from '@/lib/engine/experiment/execution-concurrency'
import type {
  BenchmarkRunConfig,
  JsonValue,
} from '../../../packages/benchmark-protocol/src/contracts'
import type { Prisma } from '@prisma/client'
import {
  benchmarkDispatchDigest,
  canonicalJson,
  fingerprintJson,
  normalizeBenchmarkAgentOptions,
} from '../../../packages/benchmark-protocol/src/contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { prisma } from '@/lib/storage/prisma'

import { getBenchmarkAdapter } from './adapter-registry'
import { refreshBenchmarkImagePreparation } from './image-preparation'
import { assertBenchmarkExecutionTarget } from './execution-targets'

const ACTIVE_RUN_STATUSES = [
  'preparing',
  'dispatching',
  'dispatch_unknown',
  'running_agent',
  'collecting',
  'uploading',
  'cleaning',
]

function parseJson<T>(json: string, errorCode: string): T {
  try {
    return JSON.parse(json) as T
  } catch {
    throw new BenchmarkProtocolError(errorCode, '冻结的 Benchmark 数据不是合法 JSON')
  }
}

export async function prepareNextBenchmarkCaseRun(input: {
  experimentId: string
  callbackOrigin: string
}): Promise<{ runId: string } | null> {
  const { assertExperimentActive } = await import('@/lib/engine/experiment/cancellation-context');
  await assertExperimentActive(input.experimentId);
  const candidate = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const locked = await tx.benchmarkExperimentBinding.updateMany({
      where: { experimentId: input.experimentId, experiment: { status: 'running', deletedAt: null } },
      data: { schedulerStatus: 'running' },
    })
    if (!locked.count) return null
    const binding = await tx.benchmarkExperimentBinding.findUnique({ where: { experimentId: input.experimentId } })
    const concurrency = parseExecutionConcurrency(parseJson<BenchmarkRunConfig>(binding!.runConfigJson, 'BENCHMARK_RUN_CONFIG_INVALID').executionConcurrency)
    const active = await tx.benchmarkCaseRun.count({ where: { experimentId: input.experimentId, status: { in: ACTIVE_RUN_STATUSES } } })
    if (active >= concurrency) return null
    const budget = Number(process.env.AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS || 256)
    if (!Number.isSafeInteger(budget) || budget < 1) throw new Error('AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS 必须为正整数')
    const occupied = await tx.benchmarkCaseRun.count({ where: { status: { in: [...ACTIVE_RUN_STATUSES, 'submitted'] } } })
    if (occupied >= budget) return null
    const userBudget = Number(process.env.AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER || 128)
    if (!Number.isSafeInteger(userBudget) || userBudget < 1) throw new Error('AGENT_INSIGHT_BENCHMARK_MAX_PENDING_EVALUATIONS_PER_USER 必须为正整数')
    const experiment = await tx.experiment.findUnique({ where: { id: input.experimentId }, select: { user: true } })
    if (await tx.benchmarkCaseRun.count({ where: { experiment: { user: experiment!.user }, status: { in: [...ACTIVE_RUN_STATUSES, 'submitted'] } } }) >= userBudget) return null
    const next = await tx.benchmarkCaseRun.findFirst({
      where: { experimentId: input.experimentId, status: 'pending', experimentCase: { deletedAt: null } },
      orderBy: { ordinal: 'asc' }, select: { id: true },
    })
    if (!next) return null
    const claimed = await tx.benchmarkCaseRun.updateMany({
      where: { id: next.id, status: 'pending' },
      data: { status: 'preparing', failureCode: null, failureMessage: null },
    })
    return claimed.count === 1 ? next : null
  })
  if (!candidate) return null

  try {
    const run = await prisma.benchmarkCaseRun.findUnique({
      where: { id: candidate.id },
      include: {
        datasetCase: true,
        experiment: { include: { benchmarkBinding: true } },
      },
    })
    const binding = run?.experiment.benchmarkBinding
    const datasetCase = run?.datasetCase
    if (!run || !binding || !datasetCase) {
      throw new BenchmarkProtocolError('BENCHMARK_RUN_SNAPSHOT_MISSING', '运行所需的冻结数据不存在')
    }
    if (binding.adapterKey !== run.adapterKey) {
      throw new BenchmarkProtocolError('BENCHMARK_ADAPTER_MISMATCH', '实验与 Run 的 Adapter 不一致')
    }
    const dataset = await prisma.benchmarkDataset.findUnique({ where: { id: binding.datasetId } })
    if (!dataset || dataset.contentHash !== binding.datasetContentHash) {
      throw new BenchmarkProtocolError('BENCHMARK_DATASET_CHANGED', '实验绑定的数据集内容已变化')
    }

    const rawCase = parseJson<JsonValue>(datasetCase.rawCaseJson, 'BENCHMARK_RAW_CASE_INVALID')
    if (fingerprintJson(rawCase) !== datasetCase.sourceFingerprint) {
      throw new BenchmarkProtocolError('BENCHMARK_RAW_CASE_CHANGED', 'Case 原始快照指纹不一致')
    }
    const adapter = getBenchmarkAdapter(run.adapterKey)
    const split = adapter.validateAndSplitCase(rawCase)
    if (
      split.publicFingerprint !== datasetCase.publicFingerprint
      || split.privateFingerprint !== datasetCase.privateFingerprint
    ) {
      throw new BenchmarkProtocolError('BENCHMARK_CASE_SPLIT_CHANGED', 'Case 拆分结果与导入时不一致')
    }

    const runConfig = parseJson<BenchmarkRunConfig>(
      binding.runConfigJson,
      'BENCHMARK_RUN_CONFIG_INVALID',
    )
    const agentOptions = normalizeBenchmarkAgentOptions(runConfig.agentOptions)
    if (agentOptions) {
      const client = await prisma.reliabilityClient.findFirst({ where: {
        clientId: run.clientId, user: run.experiment.user, unboundAt: null,
      } })
      if (!client) throw new BenchmarkProtocolError('EXECUTOR_NOT_FOUND', '执行客户端不存在', 404)
      assertBenchmarkExecutionTarget(client, adapter.manifest, { ...runConfig, agentOptions })
    }
    const task = adapter.buildAgentTask({
      publicPayload: split.publicPayload,
      runConfig,
      context: {
        runId: run.id,
        experimentId: run.experimentId,
        caseId: run.experimentCaseId,
      },
    })
    const callbackBaseUrl = new URL(
      `${input.callbackOrigin.replace(/\/$/, '')}/api/benchmark/v1/runs/${encodeURIComponent(run.id)}`,
    ).toString()
    const digest = benchmarkDispatchDigest({
      runId: run.id,
      task,
      callbackBaseUrl,
      timeoutSeconds: runConfig.timeoutSeconds,
    })
    const request = {
      runId: run.id,
      requestDigest: digest,
      task,
      callbackBaseUrl,
      timeoutSeconds: runConfig.timeoutSeconds,
    }

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.benchmarkCaseRun.updateMany({
        where: { id: run.id, status: 'preparing' },
        data: {
          status: 'dispatching',
          publicPayloadJson: canonicalJson(split.publicPayload),
          privatePayloadJson: canonicalJson(split.privatePayload),
          taskEnvelopeJson: canonicalJson(task as unknown as JsonValue),
          taskDigest: digest,
        },
      })
      if (updated.count !== 1) {
        throw new BenchmarkProtocolError('BENCHMARK_RUN_CLAIM_LOST', 'Run 准备锁已失效', 409)
      }
      await tx.benchmarkDispatchOutbox.create({
        data: {
          runId: run.id,
          requestJson: canonicalJson(request as unknown as JsonValue),
          requestDigest: digest,
        },
      })
    })
    void refreshBenchmarkImagePreparation().catch((error) => console.warn('[benchmark/image-pool] preparation skipped', error))
    return { runId: run.id }
  } catch (error) {
    const protocolError = error instanceof BenchmarkProtocolError
      ? error
      : new BenchmarkProtocolError(
          'BENCHMARK_PREPARATION_FAILED',
          error instanceof Error ? error.message : 'Benchmark Run 准备失败',
        )
    await prisma.benchmarkCaseRun.updateMany({
      where: { id: candidate.id, status: 'preparing' },
      data: {
        status: 'blocked',
        failureCode: protocolError.code,
        failureMessage: protocolError.message,
        finishedAt: new Date(),
      },
    })
    throw protocolError
  }
}
