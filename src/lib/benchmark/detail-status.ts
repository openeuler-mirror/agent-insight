export type BenchmarkTraceStatus = 'pending' | 'ready' | 'failed' | null

export function benchmarkCaseProgressLabel(input: {
  runStatus: string | null | undefined
  progressStage?: string | null
  workspaceProvider?: string | null
}): string {
  switch (input.runStatus) {
    case 'pending': return '等待开始'
    case 'preparing': return '正在准备任务…'
    case 'dispatching': return '正在下发任务…'
    case 'dispatch_unknown': return '正在确认任务下发…'
    case 'running_agent':
      if (input.progressStage === 'preparing') {
        return input.workspaceProvider === 'git' ? '正在准备 Git 工作区…' : '正在准备执行环境…'
      }
      return input.progressStage === 'agent_running' ? 'Agent 执行中…' : '等待执行器启动…'
    case 'collecting': return '正在收集提交物…'
    case 'uploading': return '正在上传提交物…'
    case 'cleaning': return '正在清理执行环境…'
    case 'submitted': return '等待评测…'
    case 'evaluated': return '已完成'
    default: return '正在处理 Case…'
  }
}

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
  if (input.hasSubmission) return 'ready'
  if (!input.runStatus) return null
  if (AGENT_ACTIVE_RUN_STATUSES.has(input.runStatus)) return 'pending'
  if (AGENT_FAILED_RUN_STATUSES.has(input.runStatus)) return 'failed'
  return input.hasSubmission || input.hasExecution || input.hasTask ? 'ready' : 'failed'
}

export function isBenchmarkSubmissionAwaitingCompletion(input: {
  runStatus: string | null | undefined
  hasSubmission: boolean
}): boolean {
  return input.hasSubmission && [
    'running_agent',
    'collecting',
    'uploading',
    'cleaning',
  ].includes(input.runStatus || '')
}

export function isBenchmarkEvaluationInProgress(input: {
  runStatus: string | null | undefined
  evaluationStatus: string | null | undefined
}): boolean {
  return input.runStatus === 'submitted'
    || ACTIVE_EVALUATION_STATUSES.has(input.evaluationStatus || '')
}
