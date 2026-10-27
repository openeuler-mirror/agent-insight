import { benchmarkCaseProgressLabel, benchmarkEvaluationProgressLabel } from './detail-status'

export type BenchmarkProgressDetails = {
  createdAt: string
  finishedAt: string | null
  execution: { lastProgressAt: string | null; startedAt: string | null; stageStartedAt: string | null }
  evaluation: {
    stage: string | null
    createdAt: string
    startedAt: string | null
    finishedAt: string | null
    lastProgressAt: string | null
    failureMessage: string | null
  } | null
}

export type BenchmarkProgressInput = {
  runStatus: string
  progressStage: string | null
  workspaceProvider?: string | null
  submissionSource?: string
  evaluationStatus: string | null
  evaluationWaitCode?: string | null
  failure?: { code: string; message: string | null } | null
  progressDetails?: BenchmarkProgressDetails
}

export type ProgressStepState = 'done' | 'running' | 'pending' | 'failed' | 'cancelled' | 'skipped' | 'unreached'

const STEPS = ['等待调度', '准备执行环境', 'Agent 执行', '整理提交物', '准备评测', '执行评测', '汇总结果']
const EXECUTION_STAGE: Record<string, number> = { preparing: 1, agent_running: 2, collecting: 3, uploading: 3, cleaning: 3 }
const EVALUATION_STAGE: Record<string, number> = {
  downloading_artifacts: 4, preparing_runtime: 4, resolving_image: 4,
  running_harness: 5, collecting_evidence: 5, uploading_evidence: 5, cleaning: 5,
}
const EVALUATION_LABEL: Record<string, string> = {
  downloading_artifacts: '正在下载提交物', preparing_runtime: '正在准备评测环境', resolving_image: '正在准备评测镜像',
  running_harness: '正在运行评测', collecting_evidence: '正在收集评测证据', uploading_evidence: '正在上传评测证据', cleaning: '正在清理评测环境',
}
const ACTIVE_EVALUATION = new Set(['queued', 'dispatch_unknown', 'running_evaluator', 'normalizing'])
const FAILED_EXECUTION = new Set(['execution_failed', 'dispatch_failed', 'blocked'])
const FAILED_EVALUATION = new Set(['failed', 'normalization_failed', 'submission_invalid'])

function timestamp(value: string | null | undefined): number | null {
  const parsed = value ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

export function progressDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  if (seconds < 60) return `${seconds}秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`
}

export function benchmarkExecutionProgress(input: BenchmarkProgressInput, now: number) {
  const details = input.progressDetails
  const evaluation = details?.evaluation
  const evaluationStatus = input.evaluationStatus || ''
  const activeEvaluation = ACTIVE_EVALUATION.has(evaluationStatus)
  const inEvaluation = Boolean(evaluationStatus) || ['submitted', 'evaluated', 'evaluation_failed', 'submission_invalid'].includes(input.runStatus)
  const cancelled = input.runStatus === 'cancelled' || evaluationStatus === 'cancelled'
  const failed = !cancelled && !activeEvaluation && (
    FAILED_EXECUTION.has(input.runStatus) || FAILED_EVALUATION.has(evaluationStatus)
    || ['evaluation_failed', 'submission_invalid'].includes(input.runStatus)
  )
  const completed = !cancelled && !failed && !activeEvaluation
    && (evaluationStatus === 'completed' || input.runStatus === 'evaluated')
  const terminal = cancelled || failed || completed
  let index = 0
  let label = benchmarkCaseProgressLabel(input).replace(/…$/, '')
  if (inEvaluation) {
    index = evaluationStatus === 'normalizing' || evaluationStatus === 'normalization_failed'
      ? 6 : EVALUATION_STAGE[evaluation?.stage || ''] ?? (evaluationStatus === 'running_evaluator' ? 5 : 4)
    label = evaluationStatus === 'running_evaluator'
      ? EVALUATION_LABEL[evaluation?.stage || ''] || '正在执行评测'
      : benchmarkEvaluationProgressLabel(input).replace(/…$/, '')
    if (!evaluationStatus) label = '等待评测'
  } else if (input.runStatus === 'running_agent' || FAILED_EXECUTION.has(input.runStatus) || cancelled) {
    index = EXECUTION_STAGE[input.progressStage || ''] ?? 0
  } else {
    index = EXECUTION_STAGE[input.runStatus] ?? 0
    if (input.runStatus === 'preparing') index = 0
  }
  if (completed) { index = 6; label = '已完成' }
  if (cancelled) label = '已取消'
  if (failed) label = input.runStatus === 'submission_invalid' || evaluationStatus === 'submission_invalid' ? '提交物无效' : '处理失败'
  const known = terminal || inEvaluation || ['pending', 'preparing', 'dispatching', 'dispatch_unknown', 'running_agent', 'collecting', 'uploading', 'cleaning'].includes(input.runStatus)
  if (!known) label = '进度暂不可用'
  const active = !terminal && known
  const waiting = active && (input.runStatus === 'pending' && !inEvaluation || inEvaluation && (!evaluationStatus || evaluationStatus === 'queued'))
  const lastReportAt = timestamp(inEvaluation ? evaluation?.lastProgressAt : details?.execution.lastProgressAt)
  const reportAge = lastReportAt === null ? null : Math.max(0, now - lastReportAt)
  // 阶段回调不是心跳；延迟只提示观测缺口，不改变任务状态。
  const activityAt = lastReportAt ?? timestamp(inEvaluation ? evaluation?.startedAt || evaluation?.createdAt : details?.execution.startedAt || details?.createdAt)
  const delayed = active && !waiting && activityAt !== null && now - activityAt >= 5 * 60_000
  const startedAt = timestamp(details?.createdAt)
  const finishedAt = terminal ? timestamp(evaluation?.finishedAt || details?.finishedAt) : null
  const elapsed = startedAt === null || terminal && finishedAt === null ? null : Math.max(0, (finishedAt ?? now) - startedAt)
  const stageStartedAt = !inEvaluation && active ? timestamp(details?.execution.stageStartedAt) : null
  const steps = STEPS.map((title, stepIndex) => {
    let state: ProgressStepState = stepIndex < index || completed ? 'done' : 'pending'
    if (stepIndex === index && !completed) state = failed ? 'failed' : cancelled ? 'cancelled' : active ? 'running' : 'pending'
    if (stepIndex > index && (failed || cancelled)) state = 'unreached'
    if (input.submissionSource === 'imported' && stepIndex < 4) state = 'skipped'
    return { title, state, detail: stepIndex === index && active ? label : null }
  })
  return {
    label, active, waiting, failed, cancelled, completed, delayed, elapsed, reportAge, steps,
    stageElapsed: stageStartedAt === null ? null : Math.max(0, now - stageStartedAt),
    failureMessage: failed ? evaluation?.failureMessage || input.failure?.message || input.failure?.code || '未收到详细失败原因' : null,
  }
}

export type BenchmarkProgressSnapshot = BenchmarkProgressInput & {
  runId?: string; runAttemptNo?: number; generation?: number; revision?: number; evaluationAttemptNo?: number
  traceId?: string | null; traceTaskId?: string | null; executionId?: string | null
}

export function acceptBenchmarkProgress<T extends BenchmarkProgressSnapshot>(previous: T, next: T): T {
  if (previous.runId !== next.runId && previous.runAttemptNo && next.runAttemptNo) return next.runAttemptNo > previous.runAttemptNo ? next : previous
  if (previous.runId !== next.runId) return (next.generation || 0) < (previous.generation || 0) ? previous : next
  if ((next.revision || 0) < (previous.revision || 0) || (next.evaluationAttemptNo || 0) < (previous.evaluationAttemptNo || 0)) return previous
  const reevaluating = (next.evaluationAttemptNo || 0) > (previous.evaluationAttemptNo || 0)
  const before = benchmarkExecutionProgress(previous, 0)
  const after = benchmarkExecutionProgress(next, 0)
  const reached = (value: ReturnType<typeof benchmarkExecutionProgress>) => value.steps.reduce((index, step, i) => ['running', 'failed', 'cancelled', 'done'].includes(step.state) ? i : index, 0)
  if (!reevaluating && (reached(after) < reached(before) || (before.failed || before.cancelled || before.completed) && after.active)) return previous
  if (previous.traceId && next.traceId && previous.traceId !== next.traceId) return previous
  if (previous.traceId && !next.traceId || previous.executionId && !next.executionId) return { ...next, traceId: next.traceId || previous.traceId, traceTaskId: next.traceTaskId || previous.traceTaskId, executionId: next.executionId || previous.executionId }
  return next
}
