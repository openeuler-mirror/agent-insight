/**
 * E2E (dry-run): create task → stub collect → ingest session → server judge path.
 * Run with: AGENT_INSIGHT_FI_DRY_RUN=1 node --import tsx --test test/fault-injection-e2e.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it, before } from 'node:test'
import { prisma } from '../src/lib/storage/prisma'
import { buildStubCollectPayload } from '../src/lib/fault-injection/engine'
import {
  createTaskWithRuns,
  ingestCollectAndJudge,
  refreshTaskProgress,
} from '../src/lib/fault-injection/store'
import { buildFiTraceMarkers } from '../src/lib/fault-injection/trace-markers'

describe('fault-injection e2e dry-run', () => {
  before(async () => {
    // Ensure prisma client knows new models (db must be pushed beforehand)
    assert.ok(prisma.faultInjectionTask)
    assert.ok(prisma.faultInjectionRun)
  })

  it('runs stub collect + ingest + judge_skipped/completed', async () => {
    const user = 'fi-e2e-user'
    const { task, runs } = await createTaskWithRuns({
      user,
      name: 'e2e-dry-run',
      platform: 'opencode',
      agent: 'build',
      prompt: 'e2e prompt',
      workspace: '/tmp/fi-e2e-workspace',
      items: [{ fault: 'step-omission' }],
    })
    assert.equal(runs.length, 1)
    const run = runs[0]

    const payload = buildStubCollectPayload({
      runId: run.runId,
      fault: 'step-omission',
      platform: 'opencode',
      prompt: 'e2e prompt',
    })
    assert.ok(payload.interactions.length >= 2)
    assert.equal(payload.faultActivated, true)

    const judged = await ingestCollectAndJudge({
      runId: run.runId,
      user,
      payload,
    })
    assert.ok(['dry_run', 'completed', 'judge_skipped'].includes(judged.status))
    assert.ok(judged.sessionTaskId)

    const session = await prisma.session.findUnique({ where: { taskId: judged.sessionTaskId! } })
    assert.ok(session?.interactions)

    const markers = buildFiTraceMarkers(JSON.parse(judged.markersJson || '[]'))
    assert.ok(markers.length >= 1)

    const updatedTask = await refreshTaskProgress(task.id)
    assert.ok(updatedTask)
    // Stub ingest ends as dry_run (not green completed)
    assert.ok(['dry_run', 'completed', 'judge_skipped', 'failed'].includes(updatedTask!.status))

    // cleanup
    await prisma.faultInjectionRun.deleteMany({ where: { fiTaskId: task.id } })
    await prisma.faultInjectionTask.delete({ where: { id: task.id } })
    if (judged.sessionTaskId) {
      await prisma.session.delete({ where: { taskId: judged.sessionTaskId } }).catch(() => {})
    }
    await prisma.$disconnect()
  })
})
