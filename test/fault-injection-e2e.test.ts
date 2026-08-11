/**
 * E2E: create task → collect-shaped payload → ingest session → server judge path.
 * Run with: node --import tsx --test test/fault-injection-e2e.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'
import { prisma } from '../src/lib/storage/prisma'
import type { CollectPayload } from '../src/lib/fault-injection/engine'
import {
  createTaskWithRuns,
  ingestCollectAndJudge,
  refreshTaskProgress,
} from '../src/lib/fault-injection/store'
import { buildFiTraceMarkers } from '../src/lib/fault-injection/trace-markers'

function sampleCollectPayload(input: {
  runId: string
  fault: string
  platform: string
  prompt: string
}): CollectPayload {
  const now = Date.now()
  const sessionId = `ses_fi_e2e_${input.runId}`
  return {
    runId: input.runId,
    taskId: sessionId,
    framework: input.platform,
    fault: input.fault,
    injectionMethod: 'skill_inject',
    faultActivated: false,
    faultActivatedAt: now,
    interactions: [
      {
        messageID: `${sessionId}-user`,
        role: 'user',
        content: input.prompt,
        timestamp: now,
      },
      {
        messageID: `${sessionId}-assistant`,
        role: 'assistant',
        content: `Collect payload for fault ${input.fault}`,
        timestamp: now + 1000,
      },
    ],
    markers: [
      {
        id: `${input.runId}-activation`,
        kind: 'fault_activation',
        label: 'Fault activated',
        timestamp: now,
        severity: 'warning',
        payload: { trace_anchor: { message_id: `${sessionId}-assistant` } },
      },
    ],
  }
}

describe('fault-injection e2e ingest', () => {
  before(async () => {
    assert.ok(prisma.faultInjectionTask)
    assert.ok(prisma.faultInjectionRun)
  })

  it('runs collect ingest + judge_skipped/completed', async () => {
    const user = 'fi-e2e-user'
    const { task, runs } = await createTaskWithRuns({
      user,
      name: 'e2e-ingest',
      platform: 'opencode',
      agent: 'build',
      prompt: 'e2e prompt',
      workspace: '/tmp/fi-e2e-workspace',
      items: [{ fault: 'step-omission' }],
    })
    assert.equal(runs.length, 1)
    const run = runs[0]

    const payload = sampleCollectPayload({
      runId: run.runId,
      fault: 'step-omission',
      platform: 'opencode',
      prompt: 'e2e prompt',
    })
    assert.ok(payload.interactions.length >= 2)
    assert.equal(payload.faultActivated, false)

    const judged = await ingestCollectAndJudge({
      runId: run.runId,
      user,
      payload,
    })
    assert.ok(['completed', 'judge_skipped'].includes(judged.status))
    assert.equal(judged.status, 'judge_skipped')
    assert.ok(judged.sessionTaskId)

    const session = await prisma.session.findUnique({ where: { taskId: judged.sessionTaskId! } })
    assert.ok(session?.interactions)

    // FI collect must not mint reliability Execution (daily Trace is Insight ⓪ only).
    const execution = await prisma.execution.findFirst({
      where: { OR: [{ id: judged.sessionTaskId! }, { taskId: judged.sessionTaskId! }] },
    })
    assert.equal(execution, null)

    const markers = buildFiTraceMarkers(JSON.parse(judged.markersJson || '[]'))
    assert.ok(markers.length >= 1)
    assert.ok(markers.every((m) => m.source === 'fi'))

    const updatedTask = await refreshTaskProgress(task.id)
    assert.ok(updatedTask)
    assert.ok(['completed', 'judge_skipped', 'failed'].includes(updatedTask!.status))

    await prisma.faultInjectionRun.deleteMany({ where: { fiTaskId: task.id } })
    await prisma.faultInjectionTask.delete({ where: { id: task.id } })
    if (judged.sessionTaskId) {
      await prisma.session.delete({ where: { taskId: judged.sessionTaskId } }).catch(() => {})
    }
    await prisma.$disconnect()
  })
})
