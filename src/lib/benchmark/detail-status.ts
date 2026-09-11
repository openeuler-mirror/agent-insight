export type BenchmarkTraceStatus = 'pending' | 'ready' | 'failed' | null

const AGENT_ACTIVE_RUN_STATUSES = new Set([
  'pending',
  'preparing',
  'dispatching',
  'dispatch_unknown',
  'running_agent',
  'collecting',
  'uploading',
  'cleaning',
])

const AGENT_FAILED_RUN_STATUSES = new Set([
  'execution_failed',
  'dispatch_failed',
  'blocked',
])

const ACTIVE_EVALUATION_STATUSES = new Set([
  'queued',
  'dispatch_unknown',
  'running_evaluator',
  'normalizing',
])

export function deriveBenchmarkTraceStatus(input: {
  runStatus: string | null
  hasSubmission: boolean
  hasExecution: boolean
  hasTask: boolean
}): BenchmarkTraceStatus {
  if (!input.runStatus) return null
  if (AGENT_ACTIVE_RUN_STATUSES.has(input.runStatus)) return 'pending'
  if (AGENT_FAILED_RUN_STATUSES.has(input.runStatus)) return 'failed'
  return input.hasSubmission || input.hasExecution || input.hasTask ? 'ready' : 'failed'
}

export function isBenchmarkEvaluationInProgress(input: {
  runStatus: string | null | undefined
  evaluationStatus: string | null | undefined
}): boolean {
  return input.runStatus === 'submitted'
    || ACTIVE_EVALUATION_STATUSES.has(input.evaluationStatus || '')
}
