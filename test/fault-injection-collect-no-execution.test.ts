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

/**
 * FI collect must not mint reliability Execution (Insight ⓪ owns daily Trace).
 * Frontend shows RAS on /trace and reliability details via ras-events / markers —
 * this test only gates Execution synthesis.
 */
import assert from 'node:assert/strict'
import { describe, it, after, before } from 'node:test'
import { prisma } from '../src/lib/storage/prisma'
import { ingestCollectAndJudge, newRunId, newTaskKey } from '../src/lib/fault-injection/store'
import type { CollectPayload } from '../src/lib/fault-injection/engine'

before(() => {
  process.env.FI_JUDGE_SESSION_WAIT_MS = '0'
})

describe('FI collect does not synthesize Execution', () => {
  const user = 'fi-no-exec-user'
  let taskId = ''
  let runId = ''
  let sessionTaskId = ''

  it('updates Run without creating Session or Execution', async () => {
    const taskKey = newTaskKey()
    runId = newRunId()
    sessionTaskId = `ses_fi_no_exec_${runId.slice(-8)}`

    const task = await prisma.faultInjectionTask.create({
      data: {
        taskKey,
        name: 'no-exec',
        status: 'running',
        platform: 'opencode',
        agent: 'build',
        prompt: 'p',
        workspace: '/tmp',
        itemsJson: '[]',
        progressJson: '{}',
        user,
      },
    })
    taskId = task.id
    await prisma.faultInjectionRun.create({
      data: {
        runId,
        fiTaskId: task.id,
        itemId: 'item-1',
        user,
        platform: 'opencode',
        agent: 'build',
        fault: 'step-omission',
        status: 'running',
        requestJson: '{}',
      },
    })

    const payload: CollectPayload = {
      runId,
      taskId: sessionTaskId,
      framework: 'opencode',
      fault: 'step-omission',
      injectionMethod: 'skill_inject',
      faultActivated: false,
      interactions: [],
      markers: [],
    }

    const judged = await ingestCollectAndJudge({ runId, user, payload })
    assert.equal(judged.sessionTaskId, sessionTaskId)
    assert.equal(judged.status, 'judge_skipped')

    const session = await prisma.session.findUnique({ where: { taskId: sessionTaskId } })
    assert.equal(session, null)

    const execution = await prisma.execution.findFirst({
      where: { OR: [{ id: sessionTaskId }, { taskId: sessionTaskId }] },
    })
    assert.equal(execution, null)
  })

  after(async () => {
    if (runId) await prisma.faultInjectionRun.deleteMany({ where: { runId } }).catch(() => {})
    if (taskId) await prisma.faultInjectionTask.delete({ where: { id: taskId } }).catch(() => {})
    if (sessionTaskId) {
      await prisma.session.delete({ where: { taskId: sessionTaskId } }).catch(() => {})
    }
    await prisma.$disconnect()
  })
})
