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
import type { SkillExecutionFence } from './run-progress'

export async function ownsSkillExecution(store: Pick<Prisma.TransactionClient, 'grayscaleTask'>, fence?: SkillExecutionFence): Promise<boolean> {
  if (!fence) return true
  const task = await store.grayscaleTask.findFirst({ where: { id: fence.taskId, user: fence.user }, select: { caseStatesJson: true } })
  if (!task) return false
  try {
    const runs = JSON.parse(task.caseStatesJson)[fence.datasetCaseId]?.[fence.side]?.runs || []
    return runs.some((run: { runIndex?: number; executionClaimId?: string }) => run.runIndex === fence.runIndex && run.executionClaimId === fence.executionClaimId)
  } catch { return false }
}
