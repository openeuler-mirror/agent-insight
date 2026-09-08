import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import {
  ackTimeoutMs,
  createCommand,
  getCommand,
  markCommandDeliveryFailed,
  markSent,
} from '@/lib/reliability/command-bus'
import { dispatchCommand } from '@/lib/reliability/control-dispatch'
import { prisma } from '@/lib/storage/prisma'

import { defaultEvaluatorRuntimeConfigProvider } from './evaluator-runtime-config'
import { prepareBenchmarkEvaluation } from './evaluation-preparation-service'
import { dispatchBenchmarkEvaluation } from './evaluation-scheduler'
import { prepareNextBenchmarkCaseRun } from './orchestrator'

type BenchmarkCommandOutcome = {
  commandId: string
  status: 'accepted' | 'busy' | 'rejected' | 'delivery_failed'
  code?: string
  message?: string
  receipt?: Record<string, unknown>
}

type BenchmarkCommandDispatcher = (input: {
  user: string
  clientId: string
  request: Record<string, unknown>
}) => Promise<BenchmarkCommandOutcome>

function parseJsonRecord(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function dispatchThroughClientControl(input: {
  user: string
  clientId: string
  request: Record<string, unknown>
}): Promise<BenchmarkCommandOutcome> {
  const timeoutSeconds = Math.max(1, Number(input.request.timeoutSeconds) || 600)
  const frame = await createCommand({
    user: input.user,
    clientId: input.clientId,
    action: 'RUN_BENCHMARK_CASE',
    ttlMs: (timeoutSeconds + 90) * 1_000,
    payload: { request: input.request },
  })
  const dispatched = await dispatchCommand(input.clientId, frame)
  if (dispatched.delivered) await markSent(frame.commandId, 'wss')

  const deadline = Date.now() + Math.max(15_000, ackTimeoutMs() * 3)
  while (Date.now() < deadline) {
    const command = await getCommand(frame.commandId)
    if (command?.status === 'RUNNING' || command?.status === 'SUCCEEDED') {
      return {
        commandId: frame.commandId,
        status: 'accepted',
        receipt: parseJsonRecord(command.resultJson),
      }
    }
    if (command?.status === 'FAILED') {
      const code = command.errorCode || 'BENCHMARK_DISPATCH_REJECTED'
      return {
        commandId: frame.commandId,
        status: ['CLIENT_BUSY', 'SERVICE_BUSY'].includes(code) ? 'busy' : 'rejected',
        code,
        message: command.errorMessage || '客户端拒绝 Benchmark 任务',
      }
    }
    if (command?.status === 'EXPIRED' || command?.status === 'DELIVERY_FAILED') {
      return {
        commandId: frame.commandId,
        status: 'delivery_failed',
        code: command.errorCode || 'BENCHMARK_COMMAND_DELIVERY_FAILED',
        message: command.errorMessage || 'Benchmark 指令未送达客户端',
      }
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  const message = 'Benchmark 指令未在确认窗口内被客户端接受'
  await markCommandDeliveryFailed(frame.commandId, 'BENCHMARK_COMMAND_ACK_TIMEOUT', message)
  return {
    commandId: frame.commandId,
    status: 'delivery_failed',
    code: 'BENCHMARK_COMMAND_ACK_TIMEOUT',
    message,
  }
}

let benchmarkCommandDispatcher: BenchmarkCommandDispatcher = dispatchThroughClientControl

export function setBenchmarkCommandDispatcherForTest(
  replacement?: BenchmarkCommandDispatcher,
): void {
  benchmarkCommandDispatcher = replacement || dispatchThroughClientControl
}

function scheduleBenchmarkDispatch(runId: string, delayMs: number): void {
  const timer = setTimeout(() => {
    void dispatchBenchmarkRun(runId).catch((error) => {
      console.error('[benchmark/scheduler] delayed dispatch failed', error)
    })
  }, delayMs)
  timer.unref?.()
}

async function resumeSubmittedBenchmarkEvaluation(runId: string): Promise<void> {
  const prepared = await prepareBenchmarkEvaluation(runId)
  if (['queued', 'dispatch_unknown'].includes(prepared.status)) {
    await dispatchBenchmarkEvaluation(prepared.evaluationRunId)
  }
}

async function markDispatchFailed(
  runId: string,
  input: { commandId?: string; responseJson?: string; code: string; message: string },
): Promise<void> {
  await prisma.$transaction([
    prisma.benchmarkDispatchOutbox.update({
      where: { runId },
      data: {
        status: 'failed',
        leasedUntil: null,
        commandId: input.commandId,
        responseJson: input.responseJson,
        errorCode: input.code,
        errorMessage: input.message,
      },
    }),
    prisma.benchmarkCaseRun.update({
      where: { id: runId },
      data: {
        status: 'dispatch_failed',
        failureCode: input.code,
        failureMessage: input.message,
        finishedAt: new Date(),
      },
    }),
  ])
  const { failBenchmarkCaseResults } = await import('./experiment-lifecycle')
  await failBenchmarkCaseResults(runId, input.message).catch((error) => {
    console.error('[benchmark/scheduler] failed to settle rejected case', error)
  })
}

export async function dispatchBenchmarkRun(runId: string): Promise<void> {
  const leasedUntil = new Date(Date.now() + 30_000)
  const claimed = await prisma.benchmarkDispatchOutbox.updateMany({
    where: {
      runId,
      status: { in: ['pending', 'unknown'] },
      nextAttemptAt: { lte: new Date() },
      OR: [{ leasedUntil: null }, { leasedUntil: { lt: new Date() } }],
    },
    data: { status: 'sending', leasedUntil, attemptCount: { increment: 1 } },
  })
  if (claimed.count !== 1) return

  const outbox = await prisma.benchmarkDispatchOutbox.findUnique({
    where: { runId },
    include: {
      run: {
        select: { clientId: true, experiment: { select: { user: true } } },
      },
    },
  })
  if (!outbox) return
  try {
    const request = parseJsonRecord(outbox.requestJson)
    if (
      request.runId !== runId
      || request.requestDigest !== outbox.requestDigest
    ) {
      await markDispatchFailed(runId, {
        code: 'DISPATCH_REQUEST_INVALID',
        message: '冻结的 Benchmark 下发请求不合法',
      })
      return
    }
    const outcome = await benchmarkCommandDispatcher({
      user: outbox.run.experiment.user,
      clientId: outbox.run.clientId,
      request,
    })
    const responseText = JSON.stringify(outcome).slice(0, 64 * 1024)
    if (outcome.status === 'busy') {
      await prisma.$transaction([
        prisma.benchmarkDispatchOutbox.update({
          where: { runId },
          data: {
            status: 'pending',
            commandId: outcome.commandId,
            leasedUntil: null,
            responseJson: responseText,
            errorCode: outcome.code || 'CLIENT_BUSY',
            errorMessage: outcome.message || '客户端当前忙，等待重试',
            nextAttemptAt: new Date(Date.now() + 1_000),
          },
        }),
        prisma.benchmarkCaseRun.update({
          where: { id: runId },
          data: {
            status: 'dispatching',
            failureCode: outcome.code || 'CLIENT_BUSY',
            failureMessage: outcome.message || '客户端当前忙',
          },
        }),
      ])
      scheduleBenchmarkDispatch(runId, 1_000)
      return
    }
    if (outcome.status === 'rejected') {
      await markDispatchFailed(runId, {
        commandId: outcome.commandId,
        responseJson: responseText,
        code: outcome.code || 'DISPATCH_REJECTED',
        message: outcome.message || '客户端未接受 Benchmark 任务',
      })
      return
    }
    if (outcome.status === 'delivery_failed') {
      await prisma.benchmarkDispatchOutbox.update({
        where: { runId },
        data: { commandId: outcome.commandId, responseJson: responseText },
      })
      throw new BenchmarkProtocolError(
        outcome.code || 'BENCHMARK_COMMAND_DELIVERY_FAILED',
        outcome.message || 'Benchmark 指令未送达客户端',
        503,
      )
    }
    await prisma.$transaction([
      prisma.benchmarkDispatchOutbox.update({
        where: { runId },
        data: {
          status: 'accepted',
          commandId: outcome.commandId,
          leasedUntil: null,
          responseJson: responseText,
          errorCode: null,
          errorMessage: null,
        },
      }),
      prisma.benchmarkCaseRun.updateMany({
        where: { id: runId, status: { in: ['dispatching', 'dispatch_unknown'] } },
        data: {
          status: 'running_agent',
          failureCode: null,
          failureMessage: null,
          lastProgressAt: new Date(),
          startedAt: new Date(),
        },
      }),
    ])
  } catch (error) {
    const message = error instanceof Error ? error.message : '客户端控制通道中断'
    const code = error instanceof BenchmarkProtocolError
      ? error.code
      : 'DISPATCH_OUTCOME_UNKNOWN'
    if (outbox.attemptCount < 2) {
      await prisma.benchmarkDispatchOutbox.update({
        where: { runId },
        data: {
          status: 'unknown',
          leasedUntil: null,
          errorCode: code,
          errorMessage: message,
          nextAttemptAt: new Date(),
        },
      })
      await prisma.benchmarkCaseRun.update({
        where: { id: runId },
        data: { status: 'dispatch_unknown', failureCode: code, failureMessage: message },
      })
      await dispatchBenchmarkRun(runId)
      return
    }
    await markDispatchFailed(runId, {
      code,
      message: `执行结果未知，使用相同 runId 重试后仍失败：${message}`,
    })
  }
}

export async function startBenchmarkExperiment(input: {
  experimentId: string
  user: string
  publicCallbackOrigin: string
  executorCallbackOrigin: string
}): Promise<{
  status: 'running'
  alreadyRunning: boolean
  runId: string | null
  completion?: Promise<void>
} | null> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: input.experimentId, user: input.user, scope: 'benchmark' },
    include: { benchmarkBinding: true },
  })
  if (!experiment?.benchmarkBinding) return null

  const alreadyRunning = experiment.status === 'running'
  if (!alreadyRunning) {
    await prisma.$transaction([
      prisma.experiment.update({
        where: { id: experiment.id },
        data: { status: 'running' },
      }),
      prisma.benchmarkExperimentBinding.update({
        where: { experimentId: experiment.id },
        data: { schedulerStatus: 'running', callbackOrigin: input.publicCallbackOrigin },
      }),
    ])
  }

  await prisma.benchmarkDispatchOutbox.updateMany({
    where: { status: 'sending', leasedUntil: { lt: new Date() }, run: { experimentId: experiment.id } },
    data: { status: 'unknown', leasedUntil: null, errorCode: 'DISPATCH_LEASE_EXPIRED' },
  })
  await prisma.benchmarkCaseRun.updateMany({
    where: {
      experimentId: experiment.id,
      status: 'preparing',
      updatedAt: { lt: new Date(Date.now() - 30_000) },
    },
    data: { status: 'pending', failureCode: 'PREPARATION_LEASE_EXPIRED' },
  })

  const active = await prisma.benchmarkCaseRun.findFirst({
    where: {
      experimentId: experiment.id,
      status: {
        in: [
          'dispatching',
          'dispatch_unknown',
          'running_agent',
          'collecting',
          'uploading',
          'cleaning',
          'submitted',
        ],
      },
    },
    select: { id: true, status: true },
  })
  if (active) {
    const outbox = await prisma.benchmarkDispatchOutbox.findUnique({ where: { runId: active.id } })
    const shouldResume = outbox && ['pending', 'unknown'].includes(outbox.status)
    const completion = active.status === 'submitted'
      ? resumeSubmittedBenchmarkEvaluation(active.id)
      : shouldResume
        ? dispatchBenchmarkRun(active.id)
        : undefined
    return {
      status: 'running',
      alreadyRunning: true,
      runId: active.id,
      ...(completion ? { completion } : {}),
    }
  }

  let prepared: { runId: string } | null
  try {
    prepared = await prepareNextBenchmarkCaseRun({
      experimentId: experiment.id,
      callbackOrigin: input.executorCallbackOrigin,
    })
  } catch (error) {
    await prisma.$transaction([
      prisma.experiment.update({
        where: { id: experiment.id },
        data: { status: 'failed' },
      }),
      prisma.benchmarkExperimentBinding.update({
        where: { experimentId: experiment.id },
        data: { schedulerStatus: 'failed' },
      }),
    ])
    throw error
  }
  return {
    status: 'running',
    alreadyRunning,
    runId: prepared?.runId || null,
    ...(prepared ? { completion: dispatchBenchmarkRun(prepared.runId) } : {}),
  }
}

export async function resumeBenchmarkDispatchesAtStartup(limit = 20): Promise<number> {
  const now = new Date()
  await prisma.benchmarkDispatchOutbox.updateMany({
    where: { status: 'sending', leasedUntil: { lt: now } },
    data: { status: 'unknown', leasedUntil: null, errorCode: 'DISPATCH_LEASE_EXPIRED' },
  })
  await prisma.benchmarkCaseRun.updateMany({
    where: { status: 'preparing', updatedAt: { lt: new Date(Date.now() - 30_000) } },
    data: { status: 'pending', failureCode: 'PREPARATION_LEASE_EXPIRED' },
  })

  const bindings = await prisma.benchmarkExperimentBinding.findMany({
    where: {
      schedulerStatus: 'running',
      callbackOrigin: { not: null },
      experiment: { status: 'running', scope: 'benchmark' },
    },
    orderBy: { updatedAt: 'asc' },
    take: Math.min(100, Math.max(1, limit)),
  })
  let resumed = 0
  const executorCallbackBaseUrl = defaultEvaluatorRuntimeConfigProvider.snapshot().executorCallbackBaseUrl
  for (const binding of bindings) {
    const accepted = await prisma.benchmarkCaseRun.findFirst({
      where: {
        experimentId: binding.experimentId,
        status: { in: ['running_agent', 'collecting', 'uploading', 'cleaning', 'submitted'] },
      },
      select: { id: true, status: true },
    })
    if (accepted?.status === 'submitted') {
      resumed += 1
      void resumeSubmittedBenchmarkEvaluation(accepted.id).catch((error) => {
        console.error('[benchmark/scheduler] startup evaluation resume failed', error)
      })
      continue
    }
    if (accepted) continue

    const dueOutbox = await prisma.benchmarkDispatchOutbox.findFirst({
      where: {
        run: { experimentId: binding.experimentId },
        status: { in: ['pending', 'unknown'] },
        attemptCount: { lt: 2 },
        nextAttemptAt: { lte: now },
      },
      orderBy: { createdAt: 'asc' },
      select: { runId: true },
    })
    let runId = dueOutbox?.runId || null
    if (!runId && binding.callbackOrigin) {
      const prepared = await prepareNextBenchmarkCaseRun({
        experimentId: binding.experimentId,
        callbackOrigin: executorCallbackBaseUrl || binding.callbackOrigin,
      }).catch(() => null)
      runId = prepared?.runId || null
    }
    if (!runId) continue
    resumed += 1
    void dispatchBenchmarkRun(runId).catch((error) => {
      console.error('[benchmark/scheduler] startup dispatch failed', error)
    })
  }
  return resumed
}
