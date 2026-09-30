import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
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
  if (input.status === 'queued' && (!input.failureCode || ['SERVICE_BUSY', 'EVALUATION_QUOTA_WAIT', 'IMAGE_POOL_SPACE_LOW', 'IMAGE_POOL_PREPARING'].includes(input.failureCode))) return null
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
  const now = options.now || new Date()
  const graceMs = Math.max(0, options.graceMs ?? EVALUATION_WATCHDOG_GRACE_MS)
  const candidates = await prisma.benchmarkEvaluation.findMany({
    where: {
      status: { in: [...WATCHED_EVALUATION_STATUSES] },
      ...(options.experimentId ? { caseRun: { experimentId: options.experimentId } } : {}),
    },
    orderBy: { updatedAt: 'asc' },
    take: Math.min(500, Math.max(1, options.limit ?? 100)),
    select: {
      id: true,
      caseRunId: true,
      attemptNo: true,
      status: true,
      timeoutSeconds: true,
      progressJson: true,
      failureCode: true,
      lastProgressAt: true,
      startedAt: true,
      createdAt: true,
      updatedAt: true,
      evaluatorKey: true,
      caseRun: {
        select: { experimentId: true, experimentCaseId: true },
      },
    },
  })

  let reaped = 0
  for (const evaluation of candidates) {
    const timeout = evaluationTimeout(evaluation, now, graceMs)
    if (!timeout) continue
    const claimed = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const claim = await tx.benchmarkEvaluation.updateMany({
        where: {
          id: evaluation.id,
          status: evaluation.status,
          updatedAt: evaluation.updatedAt,
        },
        data: {
          status: 'failed',
          failureCode: timeout.code,
          failureMessage: timeout.message,
          lastProgressAt: now,
          finishedAt: now,
          continuationStatus: 'pending',
          continuationTriedAt: null,
          continuationError: null,
        },
      })
      if (claim.count !== 1) return false
      await tx.benchmarkEvaluationDispatchOutbox.updateMany({
        where: {
          evaluationId: evaluation.id,
          status: { in: ['pending', 'unknown', 'sending', 'accepted'] },
        },
        data: {
          status: 'failed',
          leasedUntil: null,
          errorCode: timeout.code,
          errorMessage: timeout.message,
        },
      })
      await tx.benchmarkCaseRun.updateMany({
        where: { id: evaluation.caseRunId, status: 'submitted' },
        data: {
          status: 'evaluation_failed',
          failureCode: timeout.code,
          failureMessage: timeout.message,
          finishedAt: now,
        },
      })
      await tx.experimentEvalResult.updateMany({
        where: {
          experimentId: evaluation.caseRun.experimentId,
          caseId: evaluation.caseRun.experimentCaseId,
          evaluatorId: `benchmark:${evaluation.evaluatorKey}`,
          status: { in: ['pending', 'running'] },
        },
        data: { status: 'failed', errorMessage: timeout.message },
      })
      return true
    })
    if (!claimed) continue
    scheduleBenchmarkEvaluationContinuation(evaluation.id)
    reaped += 1
  }
  return reaped
}

export function startBenchmarkEvaluationWatchdog(
  intervalMs = EVALUATION_WATCHDOG_INTERVAL_MS,
): void {
  if (evaluationWatchdogTimer) return
  const tick = () => {
    if (evaluationWatchdogSweep) return
    evaluationWatchdogSweep = reapStaleBenchmarkEvaluations()
      .then(async (count) => {
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
  const evaluation = await prisma.benchmarkEvaluation.findUnique({ where: { id: evaluationId }, include: { caseRun: true } });
  if (!evaluation || evaluation.status === 'cancelled') return;
  const { assertExperimentActive } = await import('@/lib/engine/experiment/cancellation-context');
  await assertExperimentActive(evaluation.caseRun.experimentId, evaluation.caseRun.experimentCaseId);
  const claimed = await prisma.benchmarkEvaluationDispatchOutbox.updateMany({
    where: {
      evaluationId,
      evaluation: { status: { not: 'cancelled' } },
      status: { in: ['pending', 'unknown'] },
      nextAttemptAt: { lte: new Date() },
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
    },
    data: { status: 'sending', leasedUntil: new Date(Date.now() + 30_000), attemptCount: { increment: 1 } },
  })
  if (claimed.count !== 1) return
  const outbox = await prisma.benchmarkEvaluationDispatchOutbox.findUnique({ where: { evaluationId } })
  if (!outbox) return
  const attemptNo = outbox.attemptCount
  let target
  try {
    target = await freezeTarget(evaluationId)
  } catch (error) {
    const protocolError = error instanceof BenchmarkProtocolError
      ? error
      : new BenchmarkProtocolError('EVALUATOR_CONFIGURATION_INVALID', '评测服务配置不合法', 500)
    if (evaluation.status === 'dispatch_unknown') {
      await markUnknown(evaluationId, attemptNo, protocolError.message)
      scheduleDispatch(evaluationId, 5000)
      return
    }
    await markFailed(evaluationId, {
      attemptNo,
      code: protocolError.code,
      message: protocolError.message,
    })
    return
  }
  let postStarted = false
  try {
    await ensureHealthy(
      target.baseUrl,
      target.evaluatorKey,
      target.benchmarkKey,
      target.targetKey,
      evaluation.status === 'dispatch_unknown',
    )
    const capacity = capacityCache.get(target.baseUrl) || 1
    const configuredQuota = process.env.AGENT_INSIGHT_BENCHMARK_EVAL_MAX_CONCURRENCY_PER_USER
    const userQuota = configuredQuota === undefined || configuredQuota === '' ? capacity : Number(configuredQuota)
    if (!Number.isSafeInteger(userQuota) || userQuota < 1) throw new BenchmarkProtocolError('EVALUATION_QUOTA_INVALID', '单用户评测并发必须为正整数', 500)
    const admitted = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Taking the SQLite write lock before counting makes concurrent dispatchers share one reservation budget.
      const lease = await tx.benchmarkEvaluationDispatchOutbox.updateMany({ where: { evaluationId, status: 'sending', attemptCount: attemptNo }, data: { status: 'sending' } })
      if (!lease.count) return false
      const current = await tx.benchmarkEvaluation.findUnique({ where: { id: evaluationId }, include: { caseRun: { include: { experiment: true } } } })
      if (!current || !DISPATCH_ACTIVE_EVALUATION_STATUSES.includes(current.status as typeof DISPATCH_ACTIVE_EVALUATION_STATUSES[number]) || current.caseRun.experiment.deletedAt || current.caseRun.experiment.status === 'cancelled') return false
      if (current.status === 'dispatch_unknown' || current.status === 'running_evaluator') return true
      const occupied = await tx.benchmarkEvaluation.findMany({
        where: { id: { not: evaluationId }, evaluatorBaseUrl: target.baseUrl,
          OR: [{ status: { in: ['running_evaluator', 'dispatch_unknown'] } },
            { status: 'queued', progressJson: { contains: 'dispatch_reserved' } }] },
        include: { caseRun: { include: { experiment: true } } },
      })
      const cancellations = await tx.experimentCancellation.findMany({ where: { status: { not: 'completed' } }, select: { targetsJson: true } })
      const cancellingIds = new Set<string>()
      for (const record of cancellations) {
        const targets = JSON.parse(record.targetsJson) as Array<{ kind: string; runId: string; confirmed?: boolean }>
        for (const target of targets) if (target.kind === 'evaluation' && !target.confirmed) cancellingIds.add(target.runId)
      }
      if (cancellingIds.size) occupied.push(...await tx.benchmarkEvaluation.findMany({
        where: { id: { in: [...cancellingIds] }, evaluatorBaseUrl: target.baseUrl, status: 'cancelled' },
        include: { caseRun: { include: { experiment: true } } },
      }))
      if (occupied.length >= capacity || occupied.filter((item) => item.caseRun.experiment.user === current.caseRun.experiment.user).length >= userQuota) return false
      const queued = await tx.benchmarkEvaluation.findMany({
        where: { status: 'queued', caseRun: { experiment: { status: 'running', deletedAt: null } },
          OR: [{ evaluatorBaseUrl: target.baseUrl }, { evaluatorBaseUrl: null }] },
        include: { caseRun: { include: { experiment: true } }, dispatch: true }, orderBy: { createdAt: 'asc' },
      })
      const recent = await tx.benchmarkEvaluation.findMany({
        where: { evaluatorBaseUrl: target.baseUrl, startedAt: { not: null } },
        include: { caseRun: { include: { experiment: true } } }, orderBy: { startedAt: 'desc' }, take: 1000,
      })
      const lastUser = new Map<string, number>(), lastExperiment = new Map<string, number>()
      for (const item of recent) {
        if (!lastUser.has(item.caseRun.experiment.user)) lastUser.set(item.caseRun.experiment.user, item.startedAt!.getTime())
        if (!lastExperiment.has(item.caseRun.experimentId)) lastExperiment.set(item.caseRun.experimentId, item.startedAt!.getTime())
      }
      const candidates = queued.filter((item) => (item.evaluatorBaseUrl || targetResolver.resolve(item.evaluatorKey).baseUrl) === target.baseUrl
        && item.dispatch && item.dispatch.nextAttemptAt <= new Date()
        && !item.progressJson?.includes('dispatch_reserved')
        && occupied.filter((run) => run.caseRun.experiment.user === item.caseRun.experiment.user).length < userQuota)
      candidates.sort((a, b) => (lastUser.get(a.caseRun.experiment.user) || 0) - (lastUser.get(b.caseRun.experiment.user) || 0)
        || (lastExperiment.get(a.caseRun.experimentId) || 0) - (lastExperiment.get(b.caseRun.experimentId) || 0)
        || a.createdAt.getTime() - b.createdAt.getTime())
      if (candidates.length && candidates[0].id !== evaluationId) return false
      await tx.benchmarkEvaluation.updateMany({ where: { id: evaluationId, status: 'queued' },
        data: { progressJson: JSON.stringify({ stage: 'dispatch_reserved' }), startedAt: new Date() } })
      return true
    })
    if (!admitted) {
      await markPending(evaluationId, { attemptNo, code: 'EVALUATION_QUOTA_WAIT', message: '等待评测资源配额', delayMs: 1000 })
      return
    }
    await assertExperimentActive(evaluation.caseRun.experimentId, evaluation.caseRun.experimentCaseId);
    postStarted = true
    const response = await dispatchFetch(`${target.baseUrl}/api/v1/evaluations`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': evaluationId,
        'x-agent-insight-request-digest': outbox.requestDigest,
      },
      body: outbox.requestJson,
      signal: AbortSignal.timeout(10_000),
    })
    const body = await responseBody(response)
    if (
      response.status === 202
      && body.value.runId === evaluationId
      && body.value.requestDigest === outbox.requestDigest
      && body.value.status === 'accepted'
    ) {
      await markAccepted(evaluationId, attemptNo, {
        status: response.status,
        responseJson: body.text,
      })
      void refreshBenchmarkImagePreparation().catch((error) => console.warn('[benchmark/image-pool]', error))
      return
    }
    const remoteCode = responseErrorCode(body.value)
    const retryable = response.status === 503
      || ['SERVICE_BUSY', 'IMAGE_POOL_SPACE_LOW', 'IMAGE_POOL_PREPARING'].includes(remoteCode)
      || (response.status === 422 && body.value.retryable === true)
    if (retryable) {
      await markPending(evaluationId, {
        attemptNo,
        status: response.status,
        responseJson: body.text,
        code: remoteCode || 'EVALUATOR_NOT_READY',
        message: `评测服务暂未接受任务（HTTP ${response.status}）`,
        delayMs: 1_000,
      })
      return
    }
    const code = response.status === 409 && remoteCode === 'RUN_ID_CONFLICT'
      ? 'RUN_ID_CONFLICT'
      : response.status === 202
        ? 'EVALUATION_DISPATCH_RESPONSE_MISMATCH'
        : remoteCode || 'EVALUATION_DISPATCH_REJECTED'
    await markFailed(evaluationId, {
      attemptNo,
      status: response.status,
      responseJson: body.text,
      code,
      message: `评测服务拒绝任务（HTTP ${response.status}）`,
    })
  } catch (error) {
    if (evaluation.status === 'dispatch_unknown') {
      await markUnknown(evaluationId, attemptNo, error instanceof Error ? error.message : '评测下发结果待确认')
      scheduleDispatch(evaluationId, 5000)
      return
    }
    if (error instanceof BenchmarkProtocolError) {
      if (error.retryable) {
        await markPending(evaluationId, {
          attemptNo,
          code: error.code,
          message: error.message,
          delayMs: 1_000,
        })
      } else {
        await markFailed(evaluationId, { attemptNo, code: error.code, message: error.message })
      }
      return
    }
    const message = error instanceof Error ? error.message : '评测服务连接中断'
    if (postStarted) {
      const state = await markUnknown(evaluationId, attemptNo, message)
      if (state === 'unknown') scheduleDispatch(evaluationId, 5000)
      return
    }
    if (!postStarted && evaluation.status === 'dispatch_unknown') {
      await markUnknown(evaluationId, attemptNo, message)
      scheduleDispatch(evaluationId, 5000)
      return
    }
    if (!postStarted) {
      await markPending(evaluationId, {
        attemptNo,
        code: 'EVALUATOR_UNREACHABLE',
        message,
        delayMs: 1_000,
      })
      return
    }
    await markFailed(evaluationId, {
      attemptNo,
      code: 'EVALUATION_DISPATCH_OUTCOME_UNKNOWN',
      message: `使用相同 evaluationId 重试后结果仍未知：${message}`,
    })
  }
}

export async function resumeBenchmarkEvaluationDispatchesAtStartup(limit = 20): Promise<number> {
  const now = new Date()
  await prisma.benchmarkEvaluation.updateMany({ where: { status: 'queued', dispatch: { status: 'sending', leasedUntil: { lt: now } } }, data: { status: 'dispatch_unknown' } })
  await prisma.benchmarkEvaluationDispatchOutbox.updateMany({
    where: { status: 'sending', leasedUntil: { lt: now } },
    data: { status: 'unknown', leasedUntil: null, errorCode: 'EVALUATION_DISPATCH_LEASE_EXPIRED' },
  })
  const outboxes = await prisma.benchmarkEvaluationDispatchOutbox.findMany({
    where: {
      nextAttemptAt: { lte: now },
      OR: [
        { status: 'pending' },
        { status: 'unknown' },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: Math.min(100, Math.max(1, limit)),
    select: { evaluationId: true },
  })
  for (const outbox of outboxes) {
    void dispatchBenchmarkEvaluation(outbox.evaluationId).catch((error) => {
      console.error('[benchmark/evaluation-scheduler] startup dispatch failed', error)
    })
  }
  return outboxes.length
}
