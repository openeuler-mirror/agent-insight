import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import type { JsonValue } from '../../../packages/benchmark-protocol/src/contracts'
import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { prisma } from '@/lib/storage/prisma'

import { getBenchmarkAdapter } from './adapter-registry'
import { benchmarkDatasetOwners } from './dataset-ownership'
import { assertBenchmarkExecutionTarget } from './execution-targets'

type BenchmarkCaseSelection =
  | { mode: 'all' }
  | { mode: 'explicit'; caseIds: string[] }

export type CreateBenchmarkExperimentInput = {
  user: string
  name: string
  agentName?: string
  datasetId: string
  agentEvalDatasetId?: string
  caseSelection: BenchmarkCaseSelection
  clientId: string
  evaluatorIds?: string[]
  runConfig: {
    platform: string
    agent: string
    model?: string
    agentTimeoutSeconds?: number
    maxParallelAgentCases?: number
  }
}

function newRunId(): string {
  return `erun_${randomUUID().replaceAll('-', '')}`
}

function newExperimentCaseId(): string {
  return `ecase_${randomUUID().replaceAll('-', '')}`
}

function parsePublicPayload(json: string): Record<string, JsonValue> {
  const value = JSON.parse(json) as JsonValue
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new BenchmarkProtocolError('DATASET_PUBLIC_PAYLOAD_INVALID', '数据集公开 Case 不是对象')
  }
  return value
}

function selectedCaseRows<T extends { id: string }>(
  allCases: T[],
  selection: BenchmarkCaseSelection,
): T[] {
  if (selection.mode === 'all') return allCases
  const ids = selection.caseIds.map(String).filter(Boolean)
  if (!ids.length || new Set(ids).size !== ids.length) {
    throw new BenchmarkProtocolError('CASE_SELECTION_INVALID', '显式 Case 选择不能为空或重复', 400)
  }
  const byId = new Map(allCases.map((row) => [row.id, row]))
  const selected = ids.map((id) => byId.get(id))
  if (selected.some((row) => !row)) {
    throw new BenchmarkProtocolError('CASE_SELECTION_INVALID', '选中的 Case 不属于该数据集', 400)
  }
  return selected as T[]
}

type BenchmarkDatasetCaseSnapshot = {
  id: string
  rawCaseJson: string
  publicPayloadJson: string
  privatePayloadJson: string
  sourceFingerprint: string
  publicFingerprint: string
  privateFingerprint: string
  ordinal: number
}

export async function createBenchmarkExperiment(input: CreateBenchmarkExperimentInput): Promise<{
  id: string
  status: string
  caseCount: number
}> {
  const user = input.user.trim()
  const name = input.name.trim()
  const datasetId = input.datasetId.trim()
  const clientId = input.clientId.trim()
  const platform = input.runConfig.platform.trim()
  const agent = input.runConfig.agent.trim()
  if (!user || !name || !datasetId || !clientId || !platform || !agent) {
    throw new BenchmarkProtocolError(
      'BENCHMARK_EXPERIMENT_INVALID',
      'name、datasetId、clientId、platform 和 agent 均为必填项',
      400,
    )
  }
  if (input.runConfig.maxParallelAgentCases != null && input.runConfig.maxParallelAgentCases !== 1) {
    throw new BenchmarkProtocolError(
      'AGENT_PARALLELISM_UNSUPPORTED',
      '第一阶段 maxParallelAgentCases 只支持 1',
      400,
    )
  }
  const dataset = await prisma.benchmarkDataset.findFirst({
    where: { id: datasetId, user: { in: benchmarkDatasetOwners(user) } },
    include: {
      cases: { orderBy: { ordinal: 'asc' } },
      agentEvalDataset: { select: { casesJson: true } },
    },
  })
  if (!dataset || dataset.status !== 'ready') {
    throw new BenchmarkProtocolError('BENCHMARK_DATASET_NOT_FOUND', 'Benchmark 数据集不存在或未就绪', 404)
  }
  const adapter = getBenchmarkAdapter(dataset.adapterKey)
  const catalogInputs = new Map<string, string>()
  try {
    const catalogCases = JSON.parse(dataset.agentEvalDataset.casesJson) as Array<{
      id?: unknown
      input?: unknown
    }>
    if (Array.isArray(catalogCases)) {
      for (const item of catalogCases) {
        const caseId = String(item?.id || '')
        if (caseId) catalogInputs.set(caseId, String(item?.input || ''))
      }
    }
  } catch {
    // 旧数据缺少公共投影时，下面回退到 publicPayload。
  }
  const cases = selectedCaseRows(
    dataset.cases as BenchmarkDatasetCaseSnapshot[],
    input.caseSelection,
  )
  const timeoutSeconds = input.runConfig.agentTimeoutSeconds ?? adapter.manifest.defaultTimeoutSeconds
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86_400) {
    throw new BenchmarkProtocolError('AGENT_TIMEOUT_INVALID', 'Agent 超时时间必须在 1～86400 秒之间', 400)
  }

  const client = await prisma.reliabilityClient.findFirst({ where: { clientId, user } })
  if (!client || client.unboundAt) {
    throw new BenchmarkProtocolError('EXECUTOR_NOT_FOUND', '执行客户端不存在', 404)
  }
  assertBenchmarkExecutionTarget(client, adapter.manifest, { platform, agent })

  const runConfig = {
    platform,
    agent,
    ...(input.runConfig.model?.trim() ? { model: input.runConfig.model.trim() } : {}),
    timeoutSeconds,
  }
  const evaluatorIds = Array.from(new Set([
    `benchmark:${dataset.adapterKey}`,
    ...(input.evaluatorIds || []).map(String).filter(Boolean),
  ]))
  const preparedCases = cases.map((datasetCase, ordinal) => {
    const publicPayload = parsePublicPayload(datasetCase.publicPayloadJson)
    return {
      datasetCase,
      ordinal,
      publicPayload,
      experimentCaseId: newExperimentCaseId(),
      runId: newRunId(),
    }
  })

  const experiment = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = await tx.experiment.create({
      data: {
        user,
        name,
        type: 'single',
        agentName: input.agentName?.trim() || agent,
        evaluatorIdsJson: JSON.stringify(evaluatorIds),
        status: 'draft',
        scope: 'benchmark',
        configSnapshotJson: JSON.stringify({
          datasetId: dataset.id,
          agentEvalDatasetId: input.agentEvalDatasetId || dataset.agentEvalDatasetId,
          datasetContentHash: dataset.contentHash,
          adapterKey: dataset.adapterKey,
          clientId,
          evaluatorIds,
          traceSource: 'generate',
          caseIds: preparedCases.map((row) => row.datasetCase.id),
          runConfig,
        }),
        benchmarkBinding: {
          create: {
            datasetId: dataset.id,
            datasetContentHash: dataset.contentHash,
            adapterKey: dataset.adapterKey,
            selectionJson: JSON.stringify(input.caseSelection),
            runConfigJson: JSON.stringify(runConfig),
            expectedCaseCount: preparedCases.length,
          },
        },
      },
    })
    for (const row of preparedCases) {
      const fallbackInput = row.publicPayload.problemStatement ?? row.publicPayload.input
      await tx.experimentCase.create({
        data: {
          id: row.experimentCaseId,
          experimentId: created.id,
          input: catalogInputs.get(row.datasetCase.id)
            || (typeof fallbackInput === 'string' ? fallbackInput : JSON.stringify(row.publicPayload)),
          datasetInput: JSON.stringify(row.publicPayload),
          caseValuesJson: JSON.stringify(row.publicPayload),
        },
      })
      await tx.benchmarkCaseRun.create({
        data: {
          id: row.runId,
          experimentId: created.id,
          experimentCaseId: row.experimentCaseId,
          datasetCaseId: row.datasetCase.id,
          ordinal: row.ordinal,
          status: 'pending',
          adapterKey: dataset.adapterKey,
          clientId,
          publicPayloadJson: row.datasetCase.publicPayloadJson,
        },
      })
      if (input.agentEvalDatasetId) {
        for (const evaluatorId of evaluatorIds) {
          await tx.experimentEvalResult.create({
            data: {
              experimentId: created.id,
              caseId: row.experimentCaseId,
              evaluatorId,
              status: 'pending',
            },
          })
        }
      }
    }
    return created
  })

  return { id: experiment.id, status: experiment.status, caseCount: preparedCases.length }
}
