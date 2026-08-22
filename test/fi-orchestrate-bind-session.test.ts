/**
 * FI 编排：业务 runId 与 Case.taskId 回填契约（无 Worker）。
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

process.env.DATABASE_URL = `file:${path.resolve(__dirname, '../data/witty_insight.db')}`

import { prisma } from '../src/lib/storage/prisma'
import {
  awaitFiSessionsAndBindExperimentCases,
  bindExperimentCaseToFiSession,
  hasUsableTraceInteractions,
} from '../src/lib/engine/experiment/fi-orchestrate'

test('hasUsableTraceInteractions: 只有非空 interactions 数组才是有效 Trace', () => {
  assert.equal(hasUsableTraceInteractions(null), false)
  assert.equal(hasUsableTraceInteractions(''), false)
  assert.equal(hasUsableTraceInteractions('{}'), false)
  assert.equal(hasUsableTraceInteractions('[]'), false)
  assert.equal(hasUsableTraceInteractions('[{"type":"message"}]'), true)
})

test('bindExperimentCaseToFiSession: 按业务 runId 与历史 cuid 均可回填 Case.taskId', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const user = `test-fi-bind-${suffix}@example.com`
  const businessRunId = `ras-20260812T120000-${suffix}`
  const sessionTaskId = `ses_test_bind_${suffix}`

  const experiment = await prisma.experiment.create({
    data: {
      user,
      name: `fi-bind-${suffix}`,
      status: 'idle',
      evaluatorIdsJson: '[]',
    },
  })

  const task = await prisma.faultInjectionTask.create({
    data: {
      taskKey: `tk-${suffix}`,
      name: `bind-${suffix}`,
      status: 'completed',
      platform: 'opencode',
      agent: 'default',
      prompt: 'ping',
      workspace: '/tmp',
      user,
      itemsJson: '[]',
      progressJson: '{}',
      requestJson: '{}',
    },
  })

  const run = await prisma.faultInjectionRun.create({
    data: {
      runId: businessRunId,
      fiTaskId: task.id,
      itemId: 'item-1',
      user,
      platform: 'opencode',
      agent: 'default',
      fault: 'thinking-dead-loop',
      status: 'completed',
      sessionTaskId,
      markersJson: '[]',
      requestJson: '{}',
    },
  })

  const caseA = await prisma.experimentCase.create({
    data: {
      experimentId: experiment.id,
      input: 'a',
      fiRunId: businessRunId,
      fiTaskId: task.id,
      faultInjectionType: 'thinking-dead-loop',
    },
  })
  const caseB = await prisma.experimentCase.create({
    data: {
      experimentId: experiment.id,
      input: 'b',
      fiRunId: run.id, // 历史误写 Prisma cuid
      fiTaskId: task.id,
      faultInjectionType: 'thinking-dead-loop',
    },
  })

  const execution = await prisma.execution.create({
    data: {
      taskId: sessionTaskId,
      user,
      query: 'ping',
      finalResult: 'pong',
      isSubagent: false,
    },
  })
  await prisma.session.create({
    data: {
      taskId: sessionTaskId,
      user,
      interactions: '[{"type":"message","role":"assistant","content":"pong"}]',
      endTime: new Date(),
    },
  })

  try {
    const n1 = await bindExperimentCaseToFiSession({
      fiRunKey: businessRunId,
      sessionTaskId,
    })
    assert.equal(n1, 2)

    const rows = await prisma.experimentCase.findMany({
      where: { id: { in: [caseA.id, caseB.id] } },
      select: { id: true, taskId: true, executionId: true },
    })
    assert.equal(rows.length, 2)
    for (const row of rows) {
      assert.equal(row.taskId, sessionTaskId)
      assert.equal(row.executionId, execution.id)
    }
  } finally {
    await prisma.experimentCase.deleteMany({ where: { experimentId: experiment.id } })
    await prisma.experiment.delete({ where: { id: experiment.id } }).catch(() => {})
    await prisma.session.deleteMany({ where: { taskId: sessionTaskId } })
    await prisma.execution.deleteMany({ where: { taskId: sessionTaskId } })
    await prisma.faultInjectionRun.delete({ where: { id: run.id } }).catch(() => {})
    await prisma.faultInjectionTask.delete({ where: { id: task.id } }).catch(() => {})
  }
})

test('failed FI run with sessionTaskId waits for a late completed Session and binds it', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const user = `test-fi-late-${suffix}@example.com`
  const businessRunId = `ras-20260815T120000-${suffix}`
  const sessionTaskId = `ses_test_late_${suffix}`
  const experiment = await prisma.experiment.create({
    data: {
      user,
      name: `fi-late-${suffix}`,
      status: 'running',
      evaluatorIdsJson: '[]',
    },
  })
  const task = await prisma.faultInjectionTask.create({
    data: {
      taskKey: `tk-late-${suffix}`,
      name: `late-${suffix}`,
      status: 'failed',
      platform: 'opencode',
      agent: 'build',
      prompt: 'ping',
      workspace: '/tmp',
      user,
      itemsJson: '[]',
      progressJson: '{}',
      requestJson: '{}',
    },
  })
  const run = await prisma.faultInjectionRun.create({
    data: {
      runId: businessRunId,
      fiTaskId: task.id,
      itemId: 'item-late',
      user,
      platform: 'opencode',
      agent: 'build',
      fault: 'thinking-dead-loop',
      status: 'failed',
      sessionTaskId,
      error: 'session_trace_not_ready',
      markersJson: '[]',
      requestJson: '{}',
    },
  })
  const caseRow = await prisma.experimentCase.create({
    data: {
      experimentId: experiment.id,
      input: 'ping',
      fiRunId: businessRunId,
      fiTaskId: task.id,
      faultInjectionType: 'thinking-dead-loop',
    },
  })

  const lateInsert = setTimeout(() => {
    void Promise.all([
      prisma.execution.create({
        data: {
          id: sessionTaskId,
          taskId: sessionTaskId,
          user,
          query: 'ping',
          finalResult: 'pong',
          isSubagent: false,
        },
      }),
      prisma.session.create({
        data: {
          taskId: sessionTaskId,
          user,
          interactions: '[{"type":"message","role":"assistant","content":"pong"}]',
          endTime: new Date(),
        },
      }),
    ])
  }, 50)

  try {
    const result = await awaitFiSessionsAndBindExperimentCases({
      runIds: [businessRunId],
      timeoutMs: 5_000,
      pollMs: 500,
    })
    assert.deepEqual(result.readyRunIds, [businessRunId])
    assert.deepEqual(result.failedRunIds, [])
    const rebound = await prisma.experimentCase.findUnique({ where: { id: caseRow.id } })
    assert.equal(rebound?.executionId, sessionTaskId)
    assert.equal(rebound?.taskId, sessionTaskId)
  } finally {
    clearTimeout(lateInsert)
    await prisma.experimentCase.deleteMany({ where: { experimentId: experiment.id } })
    await prisma.experiment.delete({ where: { id: experiment.id } }).catch(() => {})
    await prisma.session.deleteMany({ where: { taskId: sessionTaskId } })
    await prisma.execution.deleteMany({ where: { taskId: sessionTaskId } })
    await prisma.faultInjectionRun.delete({ where: { id: run.id } }).catch(() => {})
    await prisma.faultInjectionTask.delete({ where: { id: task.id } }).catch(() => {})
  }
})
