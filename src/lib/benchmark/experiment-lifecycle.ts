import { prisma } from '@/lib/storage/prisma'
import { evaluateEvalExperimentCase } from '@/lib/engine/experiment/run-experiment'

import { defaultEvaluatorRuntimeConfigProvider } from './evaluator-runtime-config'
import { startBenchmarkExperiment } from './scheduler'

const TERMINAL_RUN_STATUSES = [
  'evaluated',
  'evaluation_failed',
  'submission_invalid',
  'execution_failed',
  'dispatch_failed',
  'blocked',
]

function parsedObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

async function findExecution(user: string, traceId: string) {
  try {
    return await prisma.execution.findFirst({
      where: {
        user,
        isSubagent: false,
        OR: [
          { id: traceId },
          { taskId: traceId },
          { agentSessionId: traceId },
        ],
      },
      orderBy: { timestamp: 'desc' },
      select: { id: true, taskId: true, finalResult: true },
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2021') return null
    throw error
  }
}

async function waitForExecution(user: string, traceId: string) {
  const deadline = Date.now() + 30_000
  do {
    const execution = await findExecution(user, traceId)
    if (execution) return execution
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 500)
      timer.unref?.()
    })
  } while (Date.now() < deadline)
  return null
}

export async function settleBenchmarkExperimentStatus(experimentId: string): Promise<void> {
  const binding = await prisma.benchmarkExperimentBinding.findUnique({
    where: { experimentId },
    select: { expectedCaseCount: true },
  })
  if (!binding) return
  const [runs, resultRows] = await Promise.all([
    prisma.benchmarkCaseRun.findMany({
      where: { experimentId },
      orderBy: { createdAt: 'desc' },
      select: { experimentCaseId: true, status: true },
    }),
    prisma.experimentEvalResult.findMany({
      where: { experimentId },
      select: { status: true },
    }),
  ])
  const latestRunStatus = new Map<string, string>()
  for (const run of runs) {
    if (!latestRunStatus.has(run.experimentCaseId)) latestRunStatus.set(run.experimentCaseId, run.status)
  }
  const terminalRuns = Array.from(latestRunStatus.values())
    .filter((status) => TERMINAL_RUN_STATUSES.includes(status)).length
  const resultPending = resultRows.some((row: { status: string }) => row.status === 'pending' || row.status === 'running')
  if (terminalRuns !== binding.expectedCaseCount || resultPending) return
  const anyDone = resultRows.some((row: { status: string }) => row.status === 'done')
  await prisma.$transaction([
    prisma.experiment.update({
      where: { id: experimentId },
      data: { status: anyDone ? 'done' : 'failed' },
    }),
    prisma.benchmarkExperimentBinding.update({
      where: { experimentId },
      data: { schedulerStatus: anyDone ? 'done' : 'failed' },
    }),
  ])
}

async function continueExperiment(experimentId: string): Promise<void> {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    include: { benchmarkBinding: true },
  })
  const callbackOrigin = experiment?.benchmarkBinding?.callbackOrigin
  if (!experiment || !callbackOrigin || experiment.status !== 'running') return
  const runtime = defaultEvaluatorRuntimeConfigProvider.snapshot()
  const next = await startBenchmarkExperiment({
    experimentId,
    user: experiment.user,
    publicCallbackOrigin: callbackOrigin,
    executorCallbackOrigin: runtime.executorCallbackBaseUrl || callbackOrigin,
  })
  next?.completion?.catch((error) => {
    console.error('[benchmark/lifecycle] next case dispatch failed', error)
  })
}

export async function finalizeBenchmarkCase(input: {
  caseRunId: string
  runSupplementalEvaluators: boolean
  continueCases: boolean
}): Promise<void> {
  const run = await prisma.benchmarkCaseRun.findUnique({
    where: { id: input.caseRunId },
    include: {
      experiment: { select: { id: true, user: true, evaluatorIdsJson: true } },
      artifacts: { where: { name: 'model.patch' }, take: 1 },
    },
  })
  if (!run) return

  const facts = parsedObject(run.runFactsJson)
  const traceId = typeof facts.traceId === 'string' ? facts.traceId.trim() : ''
  let execution: { id: string; taskId: string | null; finalResult: string | null } | null = null
  if (traceId) {
    execution = run.status === 'execution_failed'
      ? await findExecution(run.experiment.user, traceId)
      : await waitForExecution(run.experiment.user, traceId)
  }

  if (execution) {
    const patch = run.artifacts[0]
    await prisma.experimentCase.update({
      where: { id: run.experimentCaseId },
      data: {
        executionId: execution.id,
        taskId: execution.taskId || traceId,
        actualOutput: execution.finalResult || (patch ? `model.patch · ${patch.sha256}` : ''),
        traceGenerationError: null,
      },
    })
  } else if (traceId && run.status === 'execution_failed') {
    await prisma.experimentCase.update({
      where: { id: run.experimentCaseId },
      data: { taskId: traceId },
    })
  }

  let evaluatorIds: string[] = []
  try {
    const parsed = JSON.parse(run.experiment.evaluatorIdsJson || '[]')
    if (Array.isArray(parsed)) evaluatorIds = parsed.map(String).filter((id) => !id.startsWith('benchmark:'))
  } catch {
    evaluatorIds = []
  }

  if (input.runSupplementalEvaluators && evaluatorIds.length) {
    if (execution) {
      await evaluateEvalExperimentCase(
        run.experimentId,
        run.experimentCaseId,
        run.experiment.user,
        { evaluatorIds, settleExperiment: false },
      )
    } else {
      await prisma.experimentEvalResult.updateMany({
        where: {
          experimentId: run.experimentId,
          caseId: run.experimentCaseId,
          evaluatorId: { in: evaluatorIds },
          status: { in: ['pending', 'running'] },
        },
        data: {
          status: 'failed',
          errorMessage: traceId
            ? 'Agent Trace 尚未入库，无法执行补充评估器'
            : '执行器未返回 Trace ID，无法执行补充评估器',
        },
      })
    }
  }

  await settleBenchmarkExperimentStatus(run.experimentId)
  if (input.continueCases) await continueExperiment(run.experimentId)
}

export async function failBenchmarkCaseResults(caseRunId: string, message: string): Promise<void> {
  const run = await prisma.benchmarkCaseRun.findUnique({
    where: { id: caseRunId },
    select: { experimentId: true, experimentCaseId: true },
  })
  if (!run) return
  try {
    await prisma.experimentEvalResult.updateMany({
      where: {
        experimentId: run.experimentId,
        caseId: run.experimentCaseId,
        status: { in: ['pending', 'running'] },
      },
      data: { status: 'failed', errorMessage: message },
    })
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2021') {
      await prisma.$transaction([
        prisma.experiment.update({ where: { id: run.experimentId }, data: { status: 'failed' } }),
        prisma.benchmarkExperimentBinding.update({
          where: { experimentId: run.experimentId },
          data: { schedulerStatus: 'failed' },
        }),
      ])
      return
    }
    throw error
  }
  await finalizeBenchmarkCase({
    caseRunId,
    runSupplementalEvaluators: false,
    continueCases: true,
  })
}
