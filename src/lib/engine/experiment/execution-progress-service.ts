import type { Prisma, ExperimentEvalResult } from '@prisma/client'
import { prisma } from '@/lib/storage/prisma'
import type { CaseExecutionProgress } from './execution-progress'

export type CaseExecutionSnapshot = {
  progress: CaseExecutionProgress
  taskId: string | null
  executionId: string | null
  actualOutput: string
  results: ExperimentEvalResult[]
}

export async function loadCaseExecutionProgress(experimentId: string, user: string, caseIds: string[], evaluatorIds: string[], generatesTrace = false): Promise<Map<string, CaseExecutionSnapshot>> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const cases = await tx.experimentCase.findMany({
      where: { experimentId, id: { in: caseIds }, deletedAt: null, experiment: { user } },
      include: { traceAttempts: { orderBy: { attemptNo: 'desc' }, take: 1 }, results: true },
    })
    const snapshots = new Map<string, CaseExecutionSnapshot>()
    for (const row of cases) {
      const attempt = row.traceAttempts[0]
      const command = attempt?.commandId ? await tx.reliabilityCommand.findUnique({ where: { commandId: attempt.commandId }, select: { status: true, updatedAt: true } }) : null
      const fi = !attempt && row.fiRunId ? await tx.faultInjectionRun.findFirst({ where: { user, OR: [{ id: row.fiRunId }, { runId: row.fiRunId }] } }) : null
      const source = attempt ? 'generated' : row.fiRunId ? 'fault-injection' : row.traceGenerationCommandId || generatesTrace ? 'generated' : 'existing'
      const traceId = attempt ? attempt.traceId : fi ? fi.sessionTaskId : row.taskId
      const reusedTrace = attempt?.traceId ? await tx.experimentTraceAttempt.count({ where: { caseId: row.id, attemptNo: { lt: attempt.attemptNo }, traceId: attempt.traceId } }) : 0
      const candidates = !reusedTrace && (traceId || source === 'existing' && row.executionId) ? await tx.execution.findMany({
        where: { user, isSubagent: false, ...(row.executionId && (source === 'existing' || attempt?.status === 'ready' && row.taskId === traceId) ? { id: row.executionId, ...(traceId ? { taskId: traceId } : {}) } : { taskId: traceId }) },
        select: { id: true, taskId: true, finalResult: true }, take: 2,
      }) : []
      const execution = candidates.length === 1 ? candidates[0] : null
      let stage = source === 'existing' ? 3 : 0
      let status: CaseExecutionProgress['status'] = 'waiting'
      let label = source === 'existing' ? '等待评测' : '等待调度'
      let error = attempt?.errorMessage || attempt?.failureCode || fi?.error || row.traceGenerationError
      const traceReady = attempt ? attempt.status === 'ready' : source === 'existing' || Boolean(execution && row.executionId === execution.id)
      if (attempt) {
        if (['running', 'retry_wait'].includes(attempt.status)) stage = 1
        if (attempt.status === 'waiting_trace' || ['retry_wait', 'failed', 'cancelled', 'superseded'].includes(attempt.status) && (attempt.traceId || command?.status === 'SUCCEEDED')) stage = 2
        if (attempt.status === 'failed' && !attempt.traceId && attempt.commandId && command?.status !== 'SUCCEEDED') stage = 1
        if (attempt.status === 'running') {
          status = 'running'; label = 'Agent 执行中'
          if (!command || ['CREATED', 'SENT', 'RECEIVED'].includes(command.status)) {
            stage = 0; status = 'waiting'; label = '等待客户端开始执行'
          } else if (command.status === 'SUCCEEDED') {
            stage = 2; status = 'waiting'; label = '等待 Trace 入库'
          }
        }
        if (attempt.status === 'dispatching') { status = 'running'; label = '正在下发任务' }
        if (attempt.status === 'waiting_trace') { status = 'waiting'; label = '等待 Trace 入库' }
        if (attempt.status === 'retry_wait') { status = 'retry_wait'; label = '等待重试' }
        if (attempt.status === 'failed') { status = 'failed'; label = '执行失败' }
        if (['cancelled', 'superseded'].includes(attempt.status)) { status = 'cancelled'; label = '已取消' }
      } else if (fi && !traceReady) {
        stage = fi.status === 'queued' ? 0 : fi.status === 'collecting' ? 1 : 2
        status = ['failed', 'stopped'].includes(fi.status) ? fi.status === 'stopped' ? 'cancelled' : 'failed' : 'running'
        label = status === 'failed' ? '执行失败' : status === 'cancelled' ? '已取消' : stage === 0 ? '等待调度' : stage === 1 ? 'Agent 执行中' : '等待 Trace 入库'
      } else if (!traceReady && row.traceGenerationError) { status = 'failed'; label = '执行失败' }
      const evaluators = evaluatorIds.map(id => {
        const result = row.results.find(result => result.evaluatorId === id)
        return { id, status: result?.status || 'pending', error: result?.errorMessage || null }
      })
      if (traceReady) {
        stage = 3
        error = null
        status = evaluators.some(item => item.status === 'running') ? 'running' : 'waiting'
        label = status === 'running' ? '执行评测中' : '等待评测'
        if (evaluators.every(item => ['done', 'failed', 'cancelled', 'skipped'].includes(item.status))) {
          if (evaluators.some(item => item.status === 'failed')) { status = 'failed'; label = '评测失败'; error = evaluators.find(item => item.status === 'failed')?.error || '部分评测失败' }
          else if (evaluators.some(item => item.status === 'cancelled')) { status = 'cancelled'; label = '评测已取消' }
          else { status = 'done'; label = '已完成'; stage = 4 }
        }
      }
      const createdAt = attempt?.createdAt || fi?.createdAt || row.createdAt
      const updates = [createdAt, attempt?.updatedAt, command?.updatedAt, fi?.updatedAt, ...(traceReady ? row.results.map(result => result.updatedAt) : [])].filter((date): date is Date => Boolean(date))
      const revision = Math.max(...updates.map(date => date.getTime()))
      const terminal = ['done', 'failed', 'cancelled'].includes(status)
      snapshots.set(row.id, {
        taskId: execution?.taskId || traceId, executionId: execution?.id || null,
        actualOutput: traceReady ? row.actualOutput || execution?.finalResult || '' : '',
        results: traceReady ? row.results : [],
        progress: {
        identity: attempt?.id || fi?.id || row.fiRunId || `existing:${row.id}`,
        attemptNo: attempt?.attemptNo || 0, generation: createdAt.getTime(), revision,
        evaluationVersion: row.results.reduce((sum, result) => sum + result.attempts, 0),
        source, stage, status, label, startedAt: createdAt.toISOString(),
        finishedAt: terminal ? new Date(revision).toISOString() : null, updatedAt: new Date(revision).toISOString(),
        traceId: execution?.taskId || traceId, executionId: execution?.id || null, error, evaluators,
        },
      })
    }
    return snapshots
  })
}
