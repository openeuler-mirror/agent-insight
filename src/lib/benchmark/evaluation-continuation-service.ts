import { prisma } from '@/lib/storage/prisma'

const CONTINUATION_LEASE_MS = 30_000
const TERMINAL_EVALUATION_STATUSES = [
  'completed',
  'failed',
  'submission_invalid',
  'normalization_failed',
  'dispatch_failed',
]

export async function runBenchmarkEvaluationContinuation(evaluationId: string): Promise<boolean> {
  const now = new Date()
  const staleLease = new Date(now.getTime() - CONTINUATION_LEASE_MS)
  const claimed = await prisma.benchmarkEvaluation.updateMany({
    where: {
      id: evaluationId,
      status: { in: TERMINAL_EVALUATION_STATUSES },
      AND: [
        { OR: [{ failureCode: null }, { failureCode: { not: 'RESULT_PERSISTENCE_FAILED' } }] },
        { OR: [
          { continuationStatus: { in: ['pending', 'failed'] } },
          { continuationStatus: 'running', continuationTriedAt: { lte: staleLease } },
          { continuationStatus: 'running', continuationTriedAt: null },
        ] },
      ],
    },
    data: {
      continuationStatus: 'running',
      continuationAttempts: { increment: 1 },
      continuationTriedAt: now,
      continuationError: null,
    },
  })
  if (claimed.count !== 1) return false

  const evaluation = await prisma.benchmarkEvaluation.findUnique({
    where: { id: evaluationId },
    select: { caseRunId: true, attemptNo: true, continuationAttempts: true },
  })
  if (!evaluation) return false
  const ownerAttempt = evaluation.continuationAttempts
  const superseded = await prisma.benchmarkCaseRun.findFirst({
    where: { retryOfRunId: evaluation.caseRunId },
    select: { id: true },
  })
  if (superseded) {
    const completed = await prisma.benchmarkEvaluation.updateMany({
      where: {
        id: evaluationId,
        continuationStatus: 'running',
        continuationAttempts: ownerAttempt,
      },
      data: { continuationStatus: 'completed', continuationError: null },
    })
    return completed.count === 1
  }
  let lostLease = false
  const ownsLease = async (): Promise<boolean> => {
    if (lostLease) return false
    const count = await prisma.benchmarkEvaluation.count({
      where: {
        id: evaluationId,
        continuationStatus: 'running',
        continuationAttempts: ownerAttempt,
      },
    })
    return count === 1
  }
  const heartbeat = setInterval(() => {
    void prisma.benchmarkEvaluation.updateMany({
      where: {
        id: evaluationId,
        continuationStatus: 'running',
        continuationAttempts: ownerAttempt,
      },
      data: { continuationTriedAt: new Date() },
    }).then((updated) => {
      if (updated.count !== 1) lostLease = true
    }).catch((error) => {
      console.error('[benchmark/evaluation-continuation] heartbeat failed', error)
    })
  }, Math.max(1_000, Math.floor(CONTINUATION_LEASE_MS / 3)))
  heartbeat.unref?.()
  try {
    const { finalizeBenchmarkCase } = await import('./experiment-lifecycle')
    const finalized = await finalizeBenchmarkCase({
      caseRunId: evaluation.caseRunId,
      runSupplementalEvaluators: evaluation.attemptNo === 1,
      continueCases: evaluation.attemptNo === 1,
      shouldContinue: ownsLease,
    })
    if (!finalized || !(await ownsLease())) return false
    const completed = await prisma.benchmarkEvaluation.updateMany({
      where: {
        id: evaluationId,
        continuationStatus: 'running',
        continuationAttempts: ownerAttempt,
      },
      data: { continuationStatus: 'completed', continuationError: null },
    })
    return completed.count === 1
  } catch (error) {
    const message = error instanceof Error ? error.message : '评测完成后的 Case 收敛失败'
    const failed = await prisma.benchmarkEvaluation.updateMany({
      where: {
        id: evaluationId,
        continuationStatus: 'running',
        continuationAttempts: ownerAttempt,
      },
      data: { continuationStatus: 'failed', continuationError: message.slice(0, 4_000) },
    })
    if (failed.count !== 1) return false
    throw error
  } finally {
    clearInterval(heartbeat)
  }
}

export function scheduleBenchmarkEvaluationContinuation(evaluationId: string): void {
  const timer = setTimeout(() => {
    void runBenchmarkEvaluationContinuation(evaluationId).catch((error) => {
      console.error('[benchmark/evaluation-continuation] continuation failed', error)
    })
  }, 0)
  timer.unref?.()
}

export async function resumeBenchmarkEvaluationContinuations(limit = 100): Promise<number> {
  const staleLease = new Date(Date.now() - CONTINUATION_LEASE_MS)
  const candidates = await prisma.benchmarkEvaluation.findMany({
    where: {
      status: { in: TERMINAL_EVALUATION_STATUSES },
      AND: [
        { OR: [{ failureCode: null }, { failureCode: { not: 'RESULT_PERSISTENCE_FAILED' } }] },
        { OR: [
          { continuationStatus: { in: ['pending', 'failed'] } },
          { continuationStatus: 'running', continuationTriedAt: { lte: staleLease } },
          { continuationStatus: 'running', continuationTriedAt: null },
        ] },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: Math.min(500, Math.max(1, limit)),
    select: { id: true },
  })
  for (const candidate of candidates) scheduleBenchmarkEvaluationContinuation(candidate.id)
  return candidates.length
}
