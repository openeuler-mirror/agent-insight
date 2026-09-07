import { BenchmarkProtocolError } from '../../../packages/benchmark-protocol/src/errors'
import { createBenchmarkDispatchToken } from '../../../packages/benchmark-protocol/src/executor-contracts'
import { prisma } from '@/lib/storage/prisma'

import { prepareNextBenchmarkCaseRun } from './orchestrator'

type DispatchFetch = typeof fetch
let dispatchFetch: DispatchFetch = fetch

export function setBenchmarkDispatchFetchForTest(replacement?: DispatchFetch): void {
  dispatchFetch = replacement || fetch
}

function scheduleBenchmarkDispatch(runId: string, delayMs: number): void {
  const timer = setTimeout(() => {
    void dispatchBenchmarkRun(runId).catch((error) => {
      console.error('[benchmark/scheduler] delayed dispatch failed', error)
    })
  }, delayMs)
  timer.unref?.()
}

async function dispatchToken(runId: string, digest: string, clientId: string): Promise<string> {
  const credential = await prisma.reliabilityClientCredential.findFirst({
    where: { clientId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { credentialHash: true },
  })
  if (!credential) {
    throw new BenchmarkProtocolError(
      'DISPATCH_CREDENTIAL_MISSING',
      '目标执行器没有可用设备凭据',
      500,
    )
  }
  return createBenchmarkDispatchToken({
    clientId,
    runId,
    requestDigest: digest,
    credentialHash: credential.credentialHash,
  })
}

async function markDispatchFailed(
  runId: string,
  input: { status?: number; responseJson?: string; code: string; message: string },
): Promise<void> {
  const run = await prisma.benchmarkCaseRun.findUnique({
    where: { id: runId },
    select: { experimentId: true },
  })
  await prisma.$transaction([
    prisma.benchmarkDispatchOutbox.update({
      where: { runId },
      data: {
        status: 'failed',
        leasedUntil: null,
        httpStatus: input.status,
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
    ...(run
      ? [
          prisma.experiment.update({
            where: { id: run.experimentId },
            data: { status: 'failed' },
          }),
          prisma.benchmarkExperimentBinding.update({
            where: { experimentId: run.experimentId },
            data: { schedulerStatus: 'failed' },
          }),
        ]
      : []),
  ])
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
    include: { run: { select: { clientId: true } } },
  })
  if (!outbox) return
  try {
    const response = await dispatchFetch(
      `${outbox.destinationBaseUrl}/api/v1/benchmark-executions`,
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${await dispatchToken(runId, outbox.requestDigest, outbox.run.clientId)}`,
          'content-type': 'application/json',
          'idempotency-key': runId,
          'x-agent-insight-request-digest': outbox.requestDigest,
        },
        body: outbox.requestJson,
        signal: AbortSignal.timeout(10_000),
      },
    )
    const rawResponseText = await response.text()
    const responseText = rawResponseText.slice(0, 64 * 1024)
    let responseBody: Record<string, unknown> = {}
    try {
      responseBody = responseText ? JSON.parse(responseText) as Record<string, unknown> : {}
    } catch {
      responseBody = {}
    }
    if (
      response.status !== 202
      || responseBody.runId !== runId
      || responseBody.status !== 'accepted'
      || responseBody.requestDigest !== outbox.requestDigest
    ) {
      const responseCode = typeof responseBody.error === 'object' && responseBody.error
        ? String((responseBody.error as Record<string, unknown>).code || '')
        : ''
      if (response.status === 409 && responseCode === 'SERVICE_BUSY') {
        await prisma.$transaction([
          prisma.benchmarkDispatchOutbox.update({
            where: { runId },
            data: {
              status: 'pending',
              leasedUntil: null,
              httpStatus: response.status,
              responseJson: responseText,
              errorCode: 'SERVICE_BUSY',
              errorMessage: '执行器当前忙，等待重试',
              nextAttemptAt: new Date(Date.now() + 1_000),
            },
          }),
          prisma.benchmarkCaseRun.update({
            where: { id: runId },
            data: { status: 'dispatching', failureCode: 'SERVICE_BUSY', failureMessage: '执行器当前忙' },
          }),
        ])
        scheduleBenchmarkDispatch(runId, 1_000)
        return
      }
      const code = response.status === 409 && responseCode === 'RUN_ID_CONFLICT'
        ? 'RUN_ID_CONFLICT'
        : response.status === 202
          ? 'DISPATCH_RESPONSE_MISMATCH'
          : 'DISPATCH_REJECTED'
      await markDispatchFailed(runId, {
        status: response.status,
        responseJson: responseText,
        code,
        message: `执行器未接受任务（HTTP ${response.status}）`,
      })
      return
    }
    await prisma.$transaction([
      prisma.benchmarkDispatchOutbox.update({
        where: { runId },
        data: {
          status: 'accepted',
          leasedUntil: null,
          httpStatus: response.status,
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
    if (error instanceof BenchmarkProtocolError) {
      await markDispatchFailed(runId, { code: error.code, message: error.message })
      return
    }
    const message = error instanceof Error ? error.message : '执行器连接中断'
    if (outbox.attemptCount < 2) {
      await prisma.benchmarkDispatchOutbox.update({
        where: { runId },
        data: {
          status: 'unknown',
          leasedUntil: null,
          errorCode: 'DISPATCH_OUTCOME_UNKNOWN',
          errorMessage: message,
          nextAttemptAt: new Date(),
        },
      })
      await prisma.benchmarkCaseRun.update({
        where: { id: runId },
        data: { status: 'dispatch_unknown', failureCode: 'DISPATCH_OUTCOME_UNKNOWN', failureMessage: message },
      })
      await dispatchBenchmarkRun(runId)
      return
    }
    await markDispatchFailed(runId, {
      code: 'DISPATCH_OUTCOME_UNKNOWN',
      message: `执行结果未知，使用相同 runId 重试后仍失败：${message}`,
    })
  }
}

export async function startBenchmarkExperiment(input: {
  experimentId: string
  user: string
  callbackOrigin: string
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
        data: { schedulerStatus: 'running', callbackOrigin: input.callbackOrigin },
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
        ],
      },
    },
    select: { id: true, status: true },
  })
  if (active) {
    const outbox = await prisma.benchmarkDispatchOutbox.findUnique({ where: { runId: active.id } })
    const shouldResume = outbox && ['pending', 'unknown'].includes(outbox.status)
    return {
      status: 'running',
      alreadyRunning: true,
      runId: active.id,
      ...(shouldResume ? { completion: dispatchBenchmarkRun(active.id) } : {}),
    }
  }

  let prepared: { runId: string } | null
  try {
    prepared = await prepareNextBenchmarkCaseRun({
      experimentId: experiment.id,
      callbackOrigin: input.callbackOrigin,
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
  for (const binding of bindings) {
    const accepted = await prisma.benchmarkCaseRun.findFirst({
      where: {
        experimentId: binding.experimentId,
        status: { in: ['running_agent', 'collecting', 'uploading', 'cleaning'] },
      },
      select: { id: true },
    })
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
        callbackOrigin: binding.callbackOrigin,
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
