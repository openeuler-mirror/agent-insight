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

import { acceptCaseProgress, type CaseExecutionProgress } from '@/lib/engine/experiment/execution-progress'
import type { AbCaseStates, AbRunState } from './ab-comparison'
import type { ExecutionIdentity } from '@/lib/grayscale/run-progress'

export type SkillRunProgress = CaseExecutionProgress & {
  stateRevision: number; experimentCaseId: string | null; datasetCaseId: string; side: 'a' | 'b'; roundIndex: number; runIndex: number
  executionGeneration: number; executionClaimId: string | null; traceAttemptNo: number
}
export type SkillProgressMap = Record<string, Partial<Record<'a' | 'b', SkillRunProgress[]>>>
export type SkillExecutionSnapshot = { taskId: string | null; caseStates: AbCaseStates; progress: SkillProgressMap }
export type SkillProgressRun = AbRunState & ExecutionIdentity

export function acceptSkillRunProgress(previous: SkillRunProgress | undefined, next: SkillRunProgress): SkillRunProgress {
  if (!previous) return next
  if (previous.executionGeneration !== next.executionGeneration) return next.executionGeneration > previous.executionGeneration ? next : previous
  if (previous.executionClaimId && next.executionClaimId !== previous.executionClaimId) return previous
  if (previous.traceAttemptNo !== next.traceAttemptNo) return next.traceAttemptNo > previous.traceAttemptNo ? next : previous
  if (next.stateRevision < previous.stateRevision) return previous
  const candidate = next.stateRevision > previous.stateRevision && next.revision < previous.revision ? { ...next, revision: previous.revision } : next
  return acceptCaseProgress(previous, candidate) as SkillRunProgress
}

export function acceptSkillSnapshot(previous: SkillExecutionSnapshot | undefined, next: SkillExecutionSnapshot): SkillExecutionSnapshot {
  if (!previous || previous.taskId !== next.taskId) return next
  const progress = { ...next.progress }
  const caseStates = { ...next.caseStates }
  for (const [caseId, sides] of Object.entries(next.progress)) {
    const acceptedSides = { ...sides }
    for (const side of ['a', 'b'] as const) {
      const before = previous.progress[caseId]?.[side] || []
      const runs = sides[side]
      if (!runs) continue
      const accepted = runs.map(run => acceptSkillRunProgress(before.find(item => item.runIndex === run.runIndex && item.roundIndex === run.roundIndex), run))
      acceptedSides[side] = accepted
      const incoming = next.caseStates[caseId]?.[side]
      if (incoming?.runs) {
        const merged = incoming.runs.map((run, index) => {
          const now = accepted.find(item => item.runIndex === (run.runIndex || index + 1) && item.roundIndex === (run.roundIndex || index + 1))
          const old = before.find(item => item === now)
          return old ? previous.caseStates[caseId]?.[side]?.runs?.find(item => (item.runIndex || 1) === old.runIndex && (item.roundIndex || 1) === old.roundIndex) || run : run
        })
        caseStates[caseId] = { ...caseStates[caseId], [side]: { ...incoming, runs: merged } }
      }
    }
    progress[caseId] = acceptedSides
  }
  return { ...next, progress, caseStates }
}
