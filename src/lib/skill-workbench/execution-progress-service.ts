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

import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/storage/prisma'
import { loadCaseExecutionProgressInTransaction } from '@/lib/engine/experiment/execution-progress-service'
import { readExperimentDatasetCaseBinding } from '@/lib/engine/experiment/dataset-case-binding'
import type { SkillExecutionSnapshot, SkillRunProgress, SkillProgressRun } from './execution-progress'
import type { AbCaseStates } from './ab-comparison'

const parse = (value: string | null | undefined) => { try { return JSON.parse(value || '{}') } catch { return {} } }

export async function loadSkillExecutionProgress(experimentId: string, user: string): Promise<SkillExecutionSnapshot | null> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const experiment = await tx.experiment.findFirst({ where: { id: experimentId, user, scope: 'skill-workbench', deletedAt: null } })
    if (!experiment) return null
    const config = parse(experiment.configSnapshotJson)
    const task = config.grayscaleTaskId ? await tx.grayscaleTask.findFirst({ where: { id: String(config.grayscaleTaskId), user } }) : null
    const states: AbCaseStates = parse(task?.caseStatesJson)
    const rows = await tx.experimentCase.findMany({ where: { experimentId, deletedAt: null }, select: { id: true, caseValuesJson: true, createdAt: true } })
    const cancelled = await tx.experimentCancellation.findMany({ where: { experimentId }, select: { caseKey: true } })
    const removed = new Set(cancelled.map(item => item.caseKey))
    const evaluators: string[] = JSON.parse(experiment.evaluatorIdsJson || '[]')
    const base = await loadCaseExecutionProgressInTransaction(tx, experimentId, user, rows.map(row => row.id), evaluators, config.traceSource !== 'existing')
    const result: SkillExecutionSnapshot = { taskId: task?.id || null, caseStates: {}, progress: {} }
    const datasetCases = new Set<string>((config.caseIds || []).map(String))
    if (!task) for (const row of rows) datasetCases.add(config.traceSource === 'existing' ? row.id : readExperimentDatasetCaseBinding(parse(row.caseValuesJson))?.caseId || row.id)
    const sides: Array<'a' | 'b'> = config.executionSides || (experiment.preset === 'skill-ab' ? ['a', 'b'] : ['b'])
    for (const caseId of datasetCases) {
      if (removed.has(`dataset:${caseId}`) || removed.has(caseId)) continue
      result.progress[caseId] = {}
      if (states[caseId]) result.caseStates[caseId] = states[caseId]
      for (const side of sides) {
        const state = states[caseId]?.[side]
        const rounds = Math.max(1, Number(config.repeatRounds) || 1)
        const sourceRuns: SkillProgressRun[] = state?.runs?.length ? state.runs : state ? [state] : Array.from({ length: rounds }, (_, index) => ({ runIndex: index + 1, roundIndex: index + 1 }))
        result.progress[caseId][side] = []
        for (const [index, run] of sourceRuns.entries()) {
          const row = rows.find(item => item.id === run.experimentCaseId)
            || (!task || experiment.preset === 'trigger' ? rows.find(item => item.id === caseId || readExperimentDatasetCaseBinding(parse(item.caseValuesJson))?.caseId === caseId) : undefined)
          const snapshot = row ? base.get(row.id) : undefined
          const candidate = snapshot?.progress
          const matching = candidate && (!run.executionClaimId || run.traceAttemptId === candidate.identity)
          const progress = matching ? candidate : null
          const runIndex = run.runIndex || index + 1, roundIndex = run.roundIndex || index + 1
          const generation = run.executionGeneration || run.executionAttempts || 0
          const origin = row?.createdAt || experiment.createdAt
          const startedAt = run.executionStartedAt || progress?.startedAt || origin.toISOString()
          const updatedAt = run.progressUpdatedAt || progress?.updatedAt || run.completedAt || startedAt
          let stage = progress?.stage || 0
          let status: SkillRunProgress['status'] = progress?.status || 'waiting'
          let label = progress?.label || '等待调度'
          let error = progress?.error || null
          const evaluations = (run.evaluations || []).map(item => ({ id: item.evaluatorId, status: item.status || 'pending', error: item.errorMessage || null }))
          if (run.status === 'running' && !progress) { stage = 0; status = 'waiting'; label = '等待客户端开始执行' }
          if (run.status === 'executed') { stage = 3; status = 'waiting'; label = '等待评测' }
          if (run.status === 'evaluating') { stage = 3; status = 'running'; label = experiment.preset === 'trigger' ? '触发判定中' : '执行评测中' }
          if (run.status === 'pass' || run.status === 'done' || ['fail', 'failed'].includes(run.status || '') && !run.failureType && (run.sessionId || evaluations.length)) {
            status = evaluations.some(item => item.status === 'failed') || run.status === 'fail' || run.status === 'failed' ? 'failed' : 'done'; stage = status === 'done' ? 4 : 3; label = status === 'done' ? '已完成' : '评测失败'
          }
          if (run.failureType) { stage = progress?.stage || 1; status = 'failed'; label = '执行失败'; error = run.failureDetail || run.output || '执行失败' }
          if (status === 'failed') error ||= evaluations.find(item => item.status === 'failed')?.error || null
          if (experiment.status === 'cancelled' || run.status === 'cancelled') { status = 'cancelled'; label = '已取消' }
          const traceId = progress?.traceId || (!run.executionClaimId || run.executionFinishedAt ? run.sessionId || null : null)
          let executionId = progress?.executionId || null
          if (!executionId && traceId) {
            const roots = await tx.execution.findMany({ where: { user, taskId: traceId, isSubagent: false }, select: { id: true }, take: 2 })
            if (roots.length === 1) executionId = roots[0].id
          }
          result.progress[caseId][side]!.push({
            identity: `${task?.id || experimentId}:${caseId}:${side}:${runIndex}:${run.executionClaimId || 'legacy'}:${progress?.identity || 'pending'}`,
            stateRevision: run.progressRevision || 0, experimentCaseId: row?.id || null, datasetCaseId: caseId, side, runIndex, roundIndex, executionGeneration: generation,
            executionClaimId: run.executionClaimId || null, traceAttemptNo: matching ? run.traceAttemptNo || candidate?.attemptNo || 0 : 0,
            attemptNo: progress?.attemptNo || run.executionAttempts || generation,
            generation, revision: Math.max(progress?.revision || 0, Date.parse(updatedAt)),
            evaluationVersion: run.evaluationAttempts || progress?.evaluationVersion || 0,
            source: config.traceSource === 'existing' ? 'existing' : 'generated', stage, status, label,
            startedAt, updatedAt, finishedAt: ['done', 'failed', 'cancelled'].includes(status) ? run.completedAt || progress?.finishedAt || updatedAt : null,
            traceId, executionId, error, evaluators: evaluations.length ? evaluations : progress?.evaluators || [],
          })
        }
      }
    }
    return result
  })
}
