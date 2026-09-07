import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { prisma } from '@/lib/storage/prisma'

import {
  benchmarkEvaluatorToken,
  defaultEvaluatorTargetResolver,
  type EvaluatorTargetResolver,
} from './evaluator-target'

type DispatchFetch = typeof fetch
let dispatchFetch: DispatchFetch = fetch
let targetResolver: EvaluatorTargetResolver = defaultEvaluatorTargetResolver
const healthCache = new Map<string, number>()

export function setBenchmarkEvaluationDispatchFetchForTest(replacement?: DispatchFetch): void {
  dispatchFetch = replacement || fetch
  healthCache.clear()
}

export function setEvaluatorTargetResolverForTest(replacement?: EvaluatorTargetResolver): void {
  targetResolver = replacement || defaultEvaluatorTargetResolver
  healthCache.clear()
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

async function markPending(evaluationId: string, input: {
  status?: number
  responseJson?: string
  code: string
  message: string
  delayMs: number
}): Promise<void> {
  const nextAttemptAt = new Date(Date.now() + input.delayMs)
  await prisma.$transaction([
    prisma.benchmarkEvaluationDispatchOutbox.update({
      where: { evaluationId },
      data: {
        status: 'pending',
        leasedUntil: null,
        httpStatus: input.status,
        responseJson: input.responseJson,
        errorCode: input.code,
        errorMessage: input.message,
        nextAttemptAt,
      },
    }),
    prisma.benchmarkEvaluation.update({
      where: { id: evaluationId },
      data: { status: 'queued', failureCode: input.code, failureMessage: input.message },
    }),
  ])
  scheduleDispatch(evaluationId, input.delayMs)
}

async function markFailed(evaluationId: string, input: {
  status?: number
  responseJson?: string
  code: string
  message: string
}): Promise<void> {
  await prisma.$transaction([
    prisma.benchmarkEvaluationDispatchOutbox.update({
      where: { evaluationId },
      data: {
        status: 'failed',
        leasedUntil: null,
        httpStatus: input.status,
        responseJson: input.responseJson,
        errorCode: input.code,
        errorMessage: input.message,
      },
    }),
    prisma.benchmarkEvaluation.update({
      where: { id: evaluationId },
      data: {
        status: 'dispatch_failed',
        failureCode: input.code,
        failureMessage: input.message,
        finishedAt: new Date(),
      },
    }),
  ])
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
        'EVALUATOR_TARGET_CREDENTIAL_STALE',
        '评测目标或发送凭证已切换；旧目标任务不能自动改用新凭证',
        409,
      )
    }
    return {
      targetKey: evaluation.evaluatorTargetKey,
      baseUrl: evaluation.evaluatorBaseUrl,
      evaluatorKey: evaluation.evaluatorKey,
      token: current.token,
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
  return target
}

async function ensureHealthy(
  baseUrl: string,
  evaluatorKey: string,
  token: string,
  targetKey: string,
): Promise<void> {
  const cacheKey = `${targetKey}\n${baseUrl}\n${evaluatorKey}`
  if ((healthCache.get(cacheKey) || 0) > Date.now() - 30_000) return
  const response = await dispatchFetch(`${baseUrl}/health`, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  })
  const body = await responseBody(response)
  const evaluators = Array.isArray(body.value.evaluators) ? body.value.evaluators : []
  const ready = evaluators.some((item) => {
    if (!item || typeof item !== 'object') return false
    const value = item as Record<string, unknown>
    return value.key === evaluatorKey && value.ready === true
  })
  if (!response.ok || body.value.status !== 'healthy' || body.value.busy === true || !ready) {
    throw new BenchmarkProtocolError(
      body.value.busy === true ? 'SERVICE_BUSY' : 'EVALUATOR_NOT_READY',
      body.value.busy === true ? '评测服务当前忙' : '评测服务未就绪',
      503,
      true,
    )
  }
  healthCache.set(cacheKey, Date.now())
}

export async function dispatchBenchmarkEvaluation(evaluationId: string): Promise<void> {
  let target
  let token
  try {
    target = await freezeTarget(evaluationId)
    token = target.token || benchmarkEvaluatorToken()
  } catch (error) {
    const protocolError = error instanceof BenchmarkProtocolError
      ? error
      : new BenchmarkProtocolError('EVALUATOR_CONFIGURATION_INVALID', '评测服务配置不合法', 500)
    await prisma.benchmarkEvaluationDispatchOutbox.updateMany({
      where: { evaluationId, status: { in: ['pending', 'unknown'] } },
      data: { errorCode: protocolError.code, errorMessage: protocolError.message },
    })
    await prisma.benchmarkEvaluation.updateMany({
      where: { id: evaluationId, status: 'queued' },
      data: { failureCode: protocolError.code, failureMessage: protocolError.message },
    })
    return
  }

  const claimed = await prisma.benchmarkEvaluationDispatchOutbox.updateMany({
    where: {
      evaluationId,
      status: { in: ['pending', 'unknown'] },
      nextAttemptAt: { lte: new Date() },
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
    },
    data: { status: 'sending', leasedUntil: new Date(Date.now() + 30_000), attemptCount: { increment: 1 } },
  })
  if (claimed.count !== 1) return
  const outbox = await prisma.benchmarkEvaluationDispatchOutbox.findUnique({ where: { evaluationId } })
  if (!outbox) return
  let postStarted = false
  try {
    await ensureHealthy(target.baseUrl, target.evaluatorKey, token, target.targetKey)
    postStarted = true
    const response = await dispatchFetch(`${target.baseUrl}/api/v1/evaluations`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
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
      await prisma.$transaction([
        prisma.benchmarkEvaluationDispatchOutbox.update({
          where: { evaluationId },
          data: {
            status: 'accepted',
            leasedUntil: null,
            httpStatus: response.status,
            responseJson: body.text,
            errorCode: null,
            errorMessage: null,
          },
        }),
        prisma.benchmarkEvaluation.updateMany({
          where: { id: evaluationId, status: { in: ['queued', 'dispatch_unknown'] } },
          data: {
            status: 'running_evaluator',
            failureCode: null,
            failureMessage: null,
            startedAt: new Date(),
          },
        }),
      ])
      return
    }
    const remoteCode = responseErrorCode(body.value)
    const retryable = response.status === 503
      || remoteCode === 'SERVICE_BUSY'
      || (response.status === 422 && body.value.retryable === true)
    if (retryable) {
      await markPending(evaluationId, {
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
      status: response.status,
      responseJson: body.text,
      code,
      message: `评测服务拒绝任务（HTTP ${response.status}）`,
    })
  } catch (error) {
    if (error instanceof BenchmarkProtocolError) {
      if (error.retryable) {
        await markPending(evaluationId, { code: error.code, message: error.message, delayMs: 1_000 })
      } else {
        await markFailed(evaluationId, { code: error.code, message: error.message })
      }
      return
    }
    const message = error instanceof Error ? error.message : '评测服务连接中断'
    if (postStarted && outbox.attemptCount < 2) {
      await prisma.$transaction([
        prisma.benchmarkEvaluationDispatchOutbox.update({
          where: { evaluationId },
          data: {
            status: 'unknown',
            leasedUntil: null,
            errorCode: 'EVALUATION_DISPATCH_OUTCOME_UNKNOWN',
            errorMessage: message,
            nextAttemptAt: new Date(),
          },
        }),
        prisma.benchmarkEvaluation.update({
          where: { id: evaluationId },
          data: {
            status: 'dispatch_unknown',
            failureCode: 'EVALUATION_DISPATCH_OUTCOME_UNKNOWN',
            failureMessage: message,
          },
        }),
      ])
      await dispatchBenchmarkEvaluation(evaluationId)
      return
    }
    if (!postStarted) {
      await markPending(evaluationId, {
        code: 'EVALUATOR_UNREACHABLE',
        message,
        delayMs: 1_000,
      })
      return
    }
    await markFailed(evaluationId, {
      code: 'EVALUATION_DISPATCH_OUTCOME_UNKNOWN',
      message: `使用相同 evaluationId 重试后结果仍未知：${message}`,
    })
  }
}

export async function resumeBenchmarkEvaluationDispatchesAtStartup(limit = 20): Promise<number> {
  const now = new Date()
  await prisma.benchmarkEvaluationDispatchOutbox.updateMany({
    where: { status: 'sending', leasedUntil: { lt: now } },
    data: { status: 'unknown', leasedUntil: null, errorCode: 'EVALUATION_DISPATCH_LEASE_EXPIRED' },
  })
  const outboxes = await prisma.benchmarkEvaluationDispatchOutbox.findMany({
    where: {
      nextAttemptAt: { lte: now },
      OR: [
        { status: 'pending' },
        { status: 'unknown', attemptCount: { lt: 2 } },
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
