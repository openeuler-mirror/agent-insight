export type CaseExecutionProgress = {
  identity: string
  attemptNo: number
  generation: number
  revision: number
  evaluationVersion: number
  source: 'generated' | 'existing' | 'fault-injection'
  stage: number
  status: 'running' | 'waiting' | 'retry_wait' | 'done' | 'failed' | 'cancelled'
  label: string
  startedAt: string
  finishedAt: string | null
  updatedAt: string
  traceId: string | null
  executionId: string | null
  error: string | null
  evaluators: Array<{ id: string; status: string; error: string | null }>
}

export function acceptCaseProgress(previous: CaseExecutionProgress | undefined, next: CaseExecutionProgress): CaseExecutionProgress {
  if (!previous) return next
  if (previous.identity !== next.identity) {
    if (previous.attemptNo > 0 && next.attemptNo > 0) return next.attemptNo > previous.attemptNo ? next : previous
    if (next.generation < previous.generation || next.generation === previous.generation && next.attemptNo <= previous.attemptNo) return previous
    return next
  }
  if (next.revision < previous.revision || next.evaluationVersion < previous.evaluationVersion) return previous
  const reevaluating = next.evaluationVersion > previous.evaluationVersion && next.stage >= 3
  if (next.stage < previous.stage && !reevaluating) return previous
  if (['done', 'failed', 'cancelled'].includes(previous.status) && !reevaluating && next.status !== previous.status) return previous
  if (previous.status === 'retry_wait' && next.stage <= previous.stage && next.status === 'running') return previous
  if (previous.traceId && next.traceId && previous.traceId !== next.traceId) return previous
  if (previous.traceId && !next.traceId || previous.executionId && !next.executionId) return { ...next, traceId: next.traceId || previous.traceId, executionId: next.executionId || previous.executionId }
  return next
}

export function caseExecutionTraceHref(progress: Pick<CaseExecutionProgress, 'executionId' | 'traceId'>): string | null {
  if (!progress.executionId) return null
  const params = new URLSearchParams({ executionId: progress.executionId })
  if (progress.traceId) params.set('taskId', progress.traceId)
  return `/trace?${params}`
}
