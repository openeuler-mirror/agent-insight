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

import { prisma } from '@/lib/storage/prisma'
import { canWriteRunProgress, stampRunProgress, type ExecutionIdentity } from './run-progress'

type Slot = ExecutionIdentity & { caseId: string; runIndex: number; roundIndex: number }

export async function commitRunProgress<R extends Slot, S extends { runs?: R[] }>(input: {
  taskId: string; user: string; caseId: string; side: 'a' | 'b'; nextRun: R
  replaceExecution?: boolean; expectedExecutionClaimId?: string; expectedEvaluationClaimId?: string
  sidePatch?: Partial<S>; touchLatestResultAt?: boolean; aggregate: (side: S) => S
}): Promise<{ run: R; side: S } | null> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const task = await prisma.grayscaleTask.findFirst({ where: { id: input.taskId, user: input.user }, select: { caseStatesJson: true, configJson: true } })
    if (!task) return null
    const states = JSON.parse(task.caseStatesJson) as Record<string, Partial<Record<'a' | 'b', S>>>
    const side = states[input.caseId]?.[input.side]
    const index = side?.runs?.findIndex(run => run.runIndex === input.nextRun.runIndex && run.roundIndex === input.nextRun.roundIndex && run.caseId === input.caseId) ?? -1
    if (!side || index < 0) return null
    const current = side.runs![index]
    if (!canWriteRunProgress(current, input.nextRun, input)) return null
    const run = stampRunProgress(current, input.nextRun)
    side.runs![index] = run
    if (input.sidePatch) Object.assign(side, input.sidePatch)
    const merged = input.aggregate(side)
    states[input.caseId][input.side] = merged
    const config = JSON.parse(task.configJson || '{}')
    if (input.touchLatestResultAt) config.latestResultAt = new Date().toISOString()
    const updated = await prisma.grayscaleTask.updateMany({
      where: { id: input.taskId, user: input.user, caseStatesJson: task.caseStatesJson, configJson: task.configJson },
      data: { caseStatesJson: JSON.stringify(states), ...(input.touchLatestResultAt ? { configJson: JSON.stringify(config) } : {}) },
    })
    if (updated.count === 1) return { run, side: merged }
    await new Promise(resolve => setTimeout(resolve, 15 + attempt * 20))
  }
  return null
}
