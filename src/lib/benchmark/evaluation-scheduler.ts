import {isStorageCoreEnabled} from '@/lib/storage-core/mode'
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

import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { platformBenchmarkConfig } from './project-config'
import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/storage/prisma'
import { refreshBenchmarkImagePreparation } from './image-preparation'

import {
  defaultEvaluatorTargetResolver,
  type EvaluatorTargetResolver,
} from './evaluator-target'
import {
  resumeBenchmarkEvaluationContinuations,
  scheduleBenchmarkEvaluationContinuation,
} from './evaluation-continuation-service'

type DispatchFetch = typeof fetch
let dispatchFetch: DispatchFetch = fetch
let targetResolver: EvaluatorTargetResolver = defaultEvaluatorTargetResolver
const healthCache = new Map<string, number>()
const capacityCache = new Map<string, number>()
const EVALUATION_WATCHDOG_INTERVAL_MS = 30_000
const EVALUATION_WATCHDOG_GRACE_MS = 90_000
const EVALUATION_STALL_TIMEOUT_MS = 5 * 60_000
const WATCHED_EVALUATION_STATUSES = [
  'queued',
  'dispatch_unknown',
  'running_evaluator',
  'normalizing',
] as const
const DISPATCH_ACTIVE_EVALUATION_STATUSES = [
  'queued',
  'dispatch_unknown',
  'running_evaluator',
] as const
const POST_HARNESS_STAGES = new Set([
  'collecting_evidence',
  'uploading_evidence',
  'cleaning',
])
let evaluationWatchdogTimer: ReturnType<typeof setInterval> | null = null
let evaluationWatchdogSweep: Promise<number> | null = null

export function setBenchmarkEvaluationDispatchFetchForTest(replacement?: DispatchFetch): void {
  dispatchFetch = replacement || fetch
  healthCache.clear()
  capacityCache.clear()
}

export function setEvaluatorTargetResolverForTest(replacement?: EvaluatorTargetResolver): void {
  targetResolver = replacement || defaultEvaluatorTargetResolver
  healthCache.clear()
  capacityCache.clear()
}

function scheduleDispatch(evaluationId: string, delayMs: number): void {
  const timer = setTimeout(() => {
    void dispatchBenchmarkEvaluation(evaluationId).catch((error) => {
      console.error('[benchmark/evaluation-scheduler] delayed dispatch failed', error)
    })
  }, delayMs)
  timer.unref?.()
}

async function responseBody(response: Response): Promise<{
  text: string
  value: Record<string, unknown>
}> {
  const text = (await response.text()).slice(0, 64 * 1024)
  try {
    return { text, value: text ? JSON.parse(text) as Record<string, unknown> : {} }
  } catch {
    return { text, value: {} }
  }
}

function responseErrorCode(value: Record<string, unknown>): string {
  return typeof value.error === 'object' && value.error
    ? String((value.error as Record<string, unknown>).code || '')
    : ''
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function evaluationTimeout(input: {
  status: string
  timeoutSeconds: number
  progressJson: string | null
  failureCode?: string | null
  lastProgressAt: Date | null
  startedAt: Date | null
  createdAt: Date
  updatedAt: Date
}, now: Date, graceMs: number): { code: string; message: string } | null {
  if (input.status === 'dispatch_unknown') return null
  if (input.status === 'queued' && (!input.failureCode || ['SERVICE_BUSY', 'EVALUATION_QUOTA_WAIT', 'IMAGE_POOL_SPACE_LOW', 'IMAGE_POOL_PREPARING', 'EVALUATOR_ASSETS_PREPARING', 'EVALUATOR_ASSETS_DOWNLOADING', 'EVALUATOR_ASSETS_VERIFYING'].includes(input.failureCode))) return null
  const progress = parseJsonRecord(input.progressJson)
  const stage = typeof progress.stage === 'string' ? progress.stage : ''
  let deadline: Date
  let code: string
  let message: string

  if (input.status === 'normalizing') {
    deadline = new Date((input.lastProgressAt || input.updatedAt).getTime() + EVALUATION_STALL_TIMEOUT_MS)
    code = 'EVALUATION_NORMALIZATION_TIMEOUT'
    message = '评测结果归一化超过 300 秒无进度，平台已自动结束任务'
  } else if (input.status === 'queued' || input.status === 'dispatch_unknown') {
    deadline = new Date(input.createdAt.getTime() + EVALUATION_STALL_TIMEOUT_MS)
    code = 'EVALUATION_DISPATCH_TIMEOUT'
    message = '评测任务下发超过 300 秒仍未被确认，平台已自动结束任务'
  } else if (POST_HARNESS_STAGES.has(stage)) {
    deadline = new Date((input.lastProgressAt || input.updatedAt).getTime() + EVALUATION_STALL_TIMEOUT_MS)
    code = 'EVALUATION_POST_PROCESS_TIMEOUT'
    message = '评测结果收集、上传或清理超过 300 秒无进度，平台已自动结束任务'
  } else {
    const timeoutMs = Math.max(1, input.timeoutSeconds) * 1_000 + graceMs
    deadline = new Date((input.startedAt || input.createdAt).getTime() + timeoutMs)
    code = 'EVALUATION_TIMEOUT'
    message = `评测执行超过 ${input.timeoutSeconds} 秒且宽限期内未完成，平台已自动结束任务`
  }
  return deadline <= now ? { code, message } : null
}

export async function reapStaleBenchmarkEvaluations(options: {
  now?: Date
  graceMs?: number
  limit?: number
  experimentId?: string
} = {}): Promise<number> {
  return 0
}

export function startBenchmarkEvaluationWatchdog(
  intervalMs = EVALUATION_WATCHDOG_INTERVAL_MS,
): void {
  if (isStorageCoreEnabled() || evaluationWatchdogTimer) return
  const tick = () => {
    if (evaluationWatchdogSweep) return
    evaluationWatchdogSweep = reapStaleBenchmarkEvaluations()
      .then(async (count) => {
        await refreshBenchmarkImagePreparation().catch((error) => console.warn('[benchmark/image-pool]', error))
        await resumeBenchmarkEvaluationContinuations()
        await resumeBenchmarkEvaluationDispatchesAtStartup()
        if (count > 0) console.warn(`[benchmark/evaluation-watchdog] 回收超时评测任务: ${count} 条`)
        return count
      })
      .catch((error) => {
        console.error('[benchmark/evaluation-watchdog] sweep failed', error)
        return 0
      })
      .finally(() => {
        evaluationWatchdogSweep = null
      })
  }
  evaluationWatchdogTimer = setInterval(tick, Math.max(1_000, intervalMs))
  evaluationWatchdogTimer.unref?.()
}

async function markPending(evaluationId: string, input: {
  attemptNo: number
  status?: number
  responseJson?: string
  code: string
  message: string
  delayMs: number
}): Promise<boolean> {
  const nextAttemptAt = new Date(Date.now() + input.delayMs)
  const transitioned = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const evaluation = await tx.benchmarkEvaluation.updateMany({
      where: {
        id: evaluationId,
        status: { in: [...DISPATCH_ACTIVE_EVALUATION_STATUSES] },
        completionDigest: null,
      },
      data: { status: 'queued', progressJson: JSON.stringify({ stage: 'waiting_resources' }), failureCode: input.code, failureMessage: input.message },
    })
    if (evaluation.count !== 1) return false
    const outbox = await tx.benchmarkEvaluationDispatchOutbox.updateMany({
      where: { evaluationId, status: 'sending', attemptCount: input.attemptNo },
      data: {
        status: 'pending',
        leasedUntil: null,
        httpStatus: input.status,
        responseJson: input.responseJson,
        errorCode: input.code,
        errorMessage: input.message,
        nextAttemptAt,
      },
    })
    if (outbox.count !== 1) {
      throw new BenchmarkProtocolError('EVALUATION_DISPATCH_OWNERSHIP_LOST', '评测下发租约已失效', 409)
    }
    return true
  }).catch((error: unknown) => {
    if (error instanceof BenchmarkProtocolError && error.code === 'EVALUATION_DISPATCH_OWNERSHIP_LOST') {
      return false
    }
    throw error
  })
  if (!transitioned) return false
  scheduleDispatch(evaluationId, input.delayMs)
  return true
}

async function markFailed(evaluationId: string, input: {
  attemptNo: number
  status?: number
  responseJson?: string
  code: string
  message: string
}): Promise<boolean> {
  const transitioned = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const evaluation = await tx.benchmarkEvaluation.findUnique({
      where: { id: evaluationId },
      include: { caseRun: { select: { id: true, experimentId: true, experimentCaseId: true } } },
    })
    if (
      !evaluation
      || !DISPATCH_ACTIVE_EVALUATION_STATUSES.includes(
        evaluation.status as typeof DISPATCH_ACTIVE_EVALUATION_STATUSES[number],
      )
      || evaluation.completionDigest
    ) {
      return null
    }
    const updatedEvaluation = await tx.benchmarkEvaluation.updateMany({
      where: {
        id: evaluationId,
        status: evaluation.status,
        completionDigest: null,
      },
      data: {
        status: 'dispatch_failed',
        failureCode: input.code,
        failureMessage: input.message,
        finishedAt: new Date(),
        continuationStatus: 'pending',
        continuationTriedAt: null,
        continuationError: null,
      },
    })
    if (updatedEvaluation.count !== 1) return null
    const outbox = await tx.benchmarkEvaluationDispatchOutbox.updateMany({
      where: { evaluationId, status: 'sending', attemptCount: input.attemptNo },
      data: {
        status: 'failed',
        leasedUntil: null,
        httpStatus: input.status,
        responseJson: input.responseJson,
        errorCode: input.code,
        errorMessage: input.message,
      },
    })
    if (outbox.count !== 1) {
      throw new BenchmarkProtocolError('EVALUATION_DISPATCH_OWNERSHIP_LOST', '评测下发租约已失效', 409)
    }
    await tx.benchmarkCaseRun.updateMany({
      where: { id: evaluation.caseRun.id, status: 'submitted' },
      data: {
        status: 'evaluation_failed',
        failureCode: input.code,
        failureMessage: input.message,
        finishedAt: new Date(),
      },
    })
    await tx.experimentEvalResult.updateMany({
      where: {
        experimentId: evaluation.caseRun.experimentId,
        caseId: evaluation.caseRun.experimentCaseId,
        evaluatorId: `benchmark:${evaluation.evaluatorKey}`,
        status: { in: ['pending', 'running'] },
      },
      data: { status: 'failed', errorMessage: input.message },
    })
    return evaluation.id
  }).catch((error: unknown) => {
    if (error instanceof BenchmarkProtocolError && error.code === 'EVALUATION_DISPATCH_OWNERSHIP_LOST') {
      return null
    }
    throw error
  })
  if (!transitioned) return false
  scheduleBenchmarkEvaluationContinuation(transitioned)
  return true
}

async function markAccepted(evaluationId: string, attemptNo: number, input: {
  status: number
  responseJson: string
}): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const evaluation = await tx.benchmarkEvaluation.findUnique({ where: { id: evaluationId } })
    if (!evaluation) return false
    if (
      !evaluation.completionDigest
      && !DISPATCH_ACTIVE_EVALUATION_STATUSES.includes(
        evaluation.status as typeof DISPATCH_ACTIVE_EVALUATION_STATUSES[number],
      )
    ) {
      return false
    }
    const outbox = await tx.benchmarkEvaluationDispatchOutbox.updateMany({
      where: { evaluationId, status: 'sending', attemptCount: attemptNo },
      data: {
        status: 'accepted',
        leasedUntil: null,
        httpStatus: input.status,
        responseJson: input.responseJson,
        errorCode: null,
        errorMessage: null,
      },
    })
    if (outbox.count !== 1) return false
    if (!evaluation.completionDigest) {
      await tx.benchmarkEvaluation.updateMany({
        where: {
          id: evaluationId,
          status: { in: [...DISPATCH_ACTIVE_EVALUATION_STATUSES] },
          completionDigest: null,
        },
        data: {
          status: 'running_evaluator',
          failureCode: null,
          failureMessage: null,
          startedAt: evaluation.startedAt || new Date(),
        },
      })
    }
    return true
  })
}

async function markUnknown(
  evaluationId: string,
  attemptNo: number,
  message: string,
): Promise<'unknown' | 'accepted' | 'lost'> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const evaluation = await tx.benchmarkEvaluation.findUnique({ where: { id: evaluationId } })
    if (!evaluation) return 'lost'
    if (evaluation.completionDigest) {
      const accepted = await tx.benchmarkEvaluationDispatchOutbox.updateMany({
        where: { evaluationId, status: 'sending', attemptCount: attemptNo },
        data: { status: 'accepted', leasedUntil: null },
      })
      return accepted.count === 1 ? 'accepted' : 'lost'
    }
    if (!DISPATCH_ACTIVE_EVALUATION_STATUSES.includes(
      evaluation.status as typeof DISPATCH_ACTIVE_EVALUATION_STATUSES[number]
    )) return 'lost'
    const updatedEvaluation = await tx.benchmarkEvaluation.updateMany({
      where: { id: evaluationId, status: evaluation.status, completionDigest: null },
      data: {
        status: 'dispatch_unknown',
        failureCode: 'EVALUATION_DISPATCH_OUTCOME_UNKNOWN',
        failureMessage: message,
      },
    })
    if (updatedEvaluation.count !== 1) return 'lost'
    const outbox = await tx.benchmarkEvaluationDispatchOutbox.updateMany({
      where: { evaluationId, status: 'sending', attemptCount: attemptNo },
      data: {
        status: 'unknown',
        leasedUntil: null,
        errorCode: 'EVALUATION_DISPATCH_OUTCOME_UNKNOWN',
        errorMessage: message,
        nextAttemptAt: new Date(),
      },
    })
    if (outbox.count !== 1) {
      throw new BenchmarkProtocolError('EVALUATION_DISPATCH_OWNERSHIP_LOST', '评测下发租约已失效', 409)
    }
    return 'unknown'
  }).catch((error: unknown) => {
    if (error instanceof BenchmarkProtocolError && error.code === 'EVALUATION_DISPATCH_OWNERSHIP_LOST') {
      return 'lost'
    }
    throw error
  })
}

async function freezeTarget(evaluationId: string) {
  const evaluation = await prisma.benchmarkEvaluation.findUnique({ where: { id: evaluationId } })
  if (!evaluation) throw new BenchmarkProtocolError('EVALUATION_NOT_FOUND', '评测 Run 不存在', 404)
  if (evaluation.evaluatorBaseUrl && evaluation.evaluatorTargetKey) {
    const current = targetResolver.resolve(evaluation.evaluatorKey)
    if (
      evaluation.evaluatorTargetKey.startsWith('runtime:')
      && (
        current.targetKey !== evaluation.evaluatorTargetKey
        || current.baseUrl !== evaluation.evaluatorBaseUrl
      )
    ) {
      throw new BenchmarkProtocolError(
        'EVALUATOR_TARGET_STALE',
        '评测目标已切换；旧目标任务不能自动改用新地址',
        409,
      )
    }
    return {
      targetKey: evaluation.evaluatorTargetKey,
      baseUrl: evaluation.evaluatorBaseUrl,
      evaluatorKey: evaluation.evaluatorKey,
      benchmarkKey: evaluation.adapterKey,
      configRevision: current.configRevision,
    }
  }
  const target = targetResolver.resolve(evaluation.evaluatorKey)
  if (target.evaluatorKey !== evaluation.evaluatorKey) {
    throw new BenchmarkProtocolError('EVALUATOR_TARGET_MISMATCH', '评测目标与任务 Evaluator 不一致', 500)
  }
  await prisma.$transaction([
    prisma.benchmarkEvaluation.updateMany({
      where: { id: evaluationId, evaluatorBaseUrl: null },
      data: { evaluatorTargetKey: target.targetKey, evaluatorBaseUrl: target.baseUrl },
    }),
    prisma.benchmarkEvaluationDispatchOutbox.update({
      where: { evaluationId },
      data: { destinationBaseUrl: target.baseUrl },
    }),
  ])
  return { ...target, benchmarkKey: evaluation.adapterKey }
}

async function ensureHealthy(
  baseUrl: string,
  evaluatorKey: string,
  benchmarkKey: string,
  targetKey: string,
  allowBusy = false,
): Promise<void> {
  const cacheKey = `${targetKey}\n${baseUrl}\n${evaluatorKey}\n${benchmarkKey}`
  if ((healthCache.get(cacheKey) || 0) > Date.now() - 30_000) return
  const response = await dispatchFetch(`${baseUrl}/health`, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(5_000),
  })
  const body = await responseBody(response)
  const evaluators = Array.isArray(body.value.evaluators) ? body.value.evaluators : []
  const evaluator = evaluators.find((item) => {
    if (!item || typeof item !== 'object') return false
    const value = item as Record<string, unknown>
    return value.key === evaluatorKey
  })
  const evaluatorState = evaluator && typeof evaluator === 'object'
    ? evaluator as Record<string, unknown>
    : null
  const bindings = Array.isArray(evaluatorState?.bindings) ? evaluatorState.bindings : []
  const binding = bindings.find((item) => {
    if (!item || typeof item !== 'object') return false
    const value = item as Record<string, unknown>
    return value.benchmarkKey === benchmarkKey || value.benchmarkKey === '*'
  }) as Record<string, unknown> | undefined
  const ready = bindings.length ? binding?.ready === true : evaluatorState?.ready === true
  const readiness = bindings.length ? binding : evaluatorState
  const facts = readiness?.runtimeFacts as Record<string, unknown> | undefined
  const assetCode = typeof facts?.assetErrorCode === 'string' ? facts.assetErrorCode : ''
  if (response.ok && body.value.status === 'healthy' && !ready && /^EVALUATOR_ASSETS_[A-Z_]+$/.test(assetCode)) {
    const retryable = ['EVALUATOR_ASSETS_PREPARING', 'EVALUATOR_ASSETS_DOWNLOADING', 'EVALUATOR_ASSETS_VERIFYING'].includes(assetCode)
    throw new BenchmarkProtocolError(assetCode,
      typeof readiness?.reason === 'string' ? readiness.reason.slice(0, 4000) : '评测资产未就绪',
      retryable ? 409 : 422, retryable)
  }
  if (!response.ok || body.value.status !== 'healthy' || (!allowBusy && body.value.busy === true) || !ready) {
    throw new BenchmarkProtocolError(
      body.value.busy === true ? 'SERVICE_BUSY' : 'EVALUATOR_NOT_READY',
      body.value.busy === true ? '评测服务当前忙' : '评测服务未就绪',
      503,
      true,
    )
  }
  capacityCache.set(baseUrl, Number.isSafeInteger(body.value.maxConcurrency) && Number(body.value.maxConcurrency) > 0 ? Number(body.value.maxConcurrency) : 1)
  healthCache.set(cacheKey, Date.now())
}

export async function dispatchBenchmarkEvaluation(evaluationId: string): Promise<void> {
  throw Object.assign(new Error('Typed Benchmark evaluation dispatch required'),{status:503})
}

export async function resumeBenchmarkEvaluationDispatchesAtStartup(limit = 20): Promise<number> {
  return 0
}
