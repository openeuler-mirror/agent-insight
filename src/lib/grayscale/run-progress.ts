/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type ExecutionIdentity = {
  executionClaimId?: string
  executionGeneration?: number
  executionAttempts?: number
  executionStartedAt?: string
  executionFinishedAt?: string
  traceAttemptId?: string
  traceAttemptNo?: number
  progressRevision?: number
  progressUpdatedAt?: string
  evaluationAttempts?: number
  evaluationClaimId?: string
  status?: string
  failureType?: string
  sessionId?: string
}

const terminal = new Set(['pass', 'fail', 'done', 'failed', 'cancelled'])
const rank = (run: ExecutionIdentity) => terminal.has(run.status || '') ? 4
  : ({ pending: 0, running: 1, executed: 2, evaluating: 3 }[run.status || ''] ?? 0)

export function canWriteRunProgress(current: ExecutionIdentity, next: ExecutionIdentity, options: {
  replaceExecution?: boolean; expectedExecutionClaimId?: string; expectedEvaluationClaimId?: string
} = {}): boolean {
  if (options.replaceExecution) return current.executionClaimId === options.expectedExecutionClaimId
    && (next.executionGeneration || 0) > (current.executionGeneration || 0)
  if (current.executionClaimId !== next.executionClaimId && (current.executionClaimId || next.executionClaimId)) return false
  if ((next.executionGeneration || 0) < (current.executionGeneration || 0)) return false
  if ((next.traceAttemptNo || 0) < (current.traceAttemptNo || 0)) return false
  if (current.traceAttemptId && next.traceAttemptNo === current.traceAttemptNo && next.traceAttemptId !== current.traceAttemptId) return false
  if ((next.progressRevision || 0) < (current.progressRevision || 0)) return false
  if (options.expectedEvaluationClaimId && current.evaluationClaimId !== options.expectedEvaluationClaimId) return false
  if ((next.evaluationAttempts || 0) < (current.evaluationAttempts || 0)) return false
  if (current.evaluationClaimId && current.evaluationClaimId !== next.evaluationClaimId && (next.evaluationAttempts || 0) <= (current.evaluationAttempts || 0)) return false
  const reevaluating = (next.evaluationAttempts || 0) > (current.evaluationAttempts || 0) && rank(next) >= 3
  if (!reevaluating && (rank(next) < rank(current) || terminal.has(current.status || '') && current.status !== next.status)) return false
  if (current.sessionId && next.sessionId && current.sessionId !== next.sessionId) return false
  return true
}

export function stampRunProgress<T extends ExecutionIdentity>(current: ExecutionIdentity, next: T): T {
  return { ...next, progressRevision: (current.progressRevision || 0) + 1, progressUpdatedAt: new Date().toISOString() }
}

export type SkillExecutionFence = {
  taskId: string; user: string; datasetCaseId: string; side: 'a' | 'b'; runIndex: number; executionClaimId: string
}
