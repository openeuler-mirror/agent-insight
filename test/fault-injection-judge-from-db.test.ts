/**
 * FI Judge / Run must read Prisma after collect ingress — not the upload body.
 */
import assert from 'node:assert/strict'
import { describe, it, after, before } from 'node:test'
import { prisma } from '../src/lib/storage/prisma'
import type { CollectPayload } from '../src/lib/fault-injection/engine'
import {
  finishFiJudgeFromDb,
  loadPersistedFiCollectForJudge,
  newRunId,
  newTaskKey,
  persistFiCollectIngress,
} from '../src/lib/fault-injection/store'

// Unit tests supply Session up front; do not block on Insight ⓪ upload lag.
before(() => {
  process.env.FI_JUDGE_SESSION_WAIT_MS = '0'
})

describe('FI Judge reads persisted Prisma rows', () => {
  const user = 'fi-judge-from-db-user'
  let taskId = ''
  let runId = ''
  let sessionTaskId = ''

  it('loadPersisted + finishFiJudge use DB markers/interactions, not upload leftovers', async () => {
    const taskKey = newTaskKey()
    runId = newRunId()
    sessionTaskId = `ses_fi_judge_db_${runId.slice(-8)}`

    const task = await prisma.faultInjectionTask.create({
      data: {
        taskKey,
        name: 'judge-from-db',
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

    // ⓪ main tree already on Session — FI collect must not invent/overwrite it.
    const dbInteractions = [
      { role: 'user', content: 'from-db', timestamp: 10 },
      { role: 'assistant', content: 'from-db-a', timestamp: 20 },
    ]
    await prisma.session.create({
      data: {
        taskId: sessionTaskId,
        label: 'pre-existing',
        query: null,
        interactions: JSON.stringify(dbInteractions),
        user,
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
      markers: [{ id: 'marker-from-upload', kind: 'fault_activation', label: 'upload' }],
    }

    await persistFiCollectIngress({ runId, user, payload })

    const sessionAfter = await prisma.session.findUnique({ where: { taskId: sessionTaskId } })
    assert.ok(sessionAfter)
    assert.deepEqual(JSON.parse(sessionAfter!.interactions || '[]'), dbInteractions)

    await prisma.faultInjectionRun.update({
      where: { runId },
      data: {
        markersJson: JSON.stringify([
          { id: 'marker-from-db', kind: 'fault_activation', label: 'db-only' },
        ]),
      },
    })

    const loaded = await loadPersistedFiCollectForJudge(runId)
    assert.deepEqual(loaded.interactions, dbInteractions)
    assert.equal((loaded.markers[0] as { id: string }).id, 'marker-from-db')
    assert.equal(loaded.faultActivated, false)

    const judged = await finishFiJudgeFromDb({ runId, user })
    assert.equal(judged.status, 'judge_skipped')

    const markers = JSON.parse(judged.markersJson || '[]') as Array<{ id?: string }>
    assert.ok(
      markers.some((m) => m.id === 'marker-from-db'),
      'evaluation merge must keep persisted FI markers from DB',
    )
    assert.ok(
      !markers.some((m) => m.id === 'marker-from-upload'),
      'upload-body markers must not reappear after DB mutation',
    )
  })

  it('persistFiCollectIngress does not create Session from collect interactions', async () => {
    const taskKey = newTaskKey()
    const localRunId = newRunId()
    const orphanTaskId = `ses_fi_no_create_${localRunId.slice(-8)}`
    const task = await prisma.faultInjectionTask.create({
      data: {
        taskKey,
        name: 'no-session-create',
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
    await prisma.faultInjectionRun.create({
      data: {
        runId: localRunId,
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
    await persistFiCollectIngress({
      runId: localRunId,
      user,
      payload: {
        runId: localRunId,
        taskId: orphanTaskId,
        framework: 'opencode',
        fault: 'step-omission',
        injectionMethod: 'skill_inject',
        faultActivated: true,
        interactions: [{ role: 'user', content: 'should-not-create-session', timestamp: 1 }],
        markers: [],
      },
    })
    const session = await prisma.session.findUnique({ where: { taskId: orphanTaskId } })
    assert.equal(session, null)
    const run = await prisma.faultInjectionRun.findUnique({ where: { runId: localRunId } })
    assert.equal(run?.sessionTaskId, orphanTaskId)
    assert.equal(run?.faultActivated, true)
    await prisma.faultInjectionRun.deleteMany({ where: { runId: localRunId } })
    await prisma.faultInjectionTask.delete({ where: { id: task.id } })
  })

  it('persistFiCollectIngress does not overwrite existing Session.interactions', async () => {
    const taskKey = newTaskKey()
    const localRunId = newRunId()
    const localSessionTaskId = `ses_fi_no_overwrite_${localRunId.slice(-8)}`
    const existing = [
      { role: 'user', content: 'keep-me', timestamp: 1 },
      { role: 'assistant', content: 'also-keep', timestamp: 2 },
    ]
    const task = await prisma.faultInjectionTask.create({
      data: {
        taskKey,
        name: 'no-session-overwrite',
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
    await prisma.session.create({
      data: {
        taskId: localSessionTaskId,
        label: 'pre-existing-overwrite-guard',
        query: null,
        interactions: JSON.stringify(existing),
        user,
      },
    })
    await prisma.faultInjectionRun.create({
      data: {
        runId: localRunId,
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
    await persistFiCollectIngress({
      runId: localRunId,
      user,
      payload: {
        runId: localRunId,
        taskId: localSessionTaskId,
        framework: 'opencode',
        fault: 'step-omission',
        injectionMethod: 'skill_inject',
        faultActivated: true,
        interactions: [{ role: 'user', content: 'fi-pollution', timestamp: 99 }],
        markers: [{ id: 'm1', kind: 'fault_activation', label: 'x' }],
      },
    })
    const session = await prisma.session.findUnique({ where: { taskId: localSessionTaskId } })
    assert.deepEqual(JSON.parse(session?.interactions || '[]'), existing)
    const run = await prisma.faultInjectionRun.findUnique({ where: { runId: localRunId } })
    assert.equal(run?.sessionTaskId, localSessionTaskId)
    assert.equal(run?.faultActivated, true)
    assert.equal(JSON.parse(run?.markersJson || '[]').length, 1)
    await prisma.faultInjectionRun.deleteMany({ where: { runId: localRunId } })
    await prisma.faultInjectionTask.delete({ where: { id: task.id } })
    await prisma.session.delete({ where: { taskId: localSessionTaskId } }).catch(() => {})
  })

  it('finishFiJudge waits for late Session.interactions before judging', async () => {
    process.env.FI_JUDGE_SESSION_WAIT_MS = '4000'
    process.env.FI_JUDGE_SESSION_POLL_MS = '200'
    const taskKey = newTaskKey()
    const localRunId = newRunId()
    const localSessionTaskId = `ses_fi_wait_${localRunId.slice(-8)}`
    const task = await prisma.faultInjectionTask.create({
      data: {
        taskKey,
        name: 'wait-session',
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
    await prisma.faultInjectionRun.create({
      data: {
        runId: localRunId,
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
    await persistFiCollectIngress({
      runId: localRunId,
      user,
      payload: {
        runId: localRunId,
        taskId: localSessionTaskId,
        framework: 'opencode',
        fault: 'step-omission',
        injectionMethod: 'skill_inject',
        faultActivated: true,
        interactions: [],
        markers: [{ id: 'm-wait', kind: 'fault_activation', label: 'wait' }],
      },
    })

    const lateTree = [
      { role: 'user', content: 'late-user', timestamp: 1 },
      { role: 'assistant', content: 'late-assistant', timestamp: 2 },
    ]
    const createLate = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        prisma.session
          .create({
            data: {
              taskId: localSessionTaskId,
              label: 'late-upload',
              query: null,
              interactions: JSON.stringify(lateTree),
              user,
            },
          })
          .then(() => resolve())
          .catch(reject)
      }, 500)
    })

    try {
      const [loaded] = await Promise.all([
        loadPersistedFiCollectForJudge(localRunId),
        createLate,
      ])
      assert.equal(loaded.sessionTraceReady, true)
      assert.deepEqual(loaded.interactions, lateTree)
      assert.ok(loaded.sessionWaitMs >= 400)
    } finally {
      process.env.FI_JUDGE_SESSION_WAIT_MS = '0'
      delete process.env.FI_JUDGE_SESSION_POLL_MS
      await prisma.faultInjectionRun.deleteMany({ where: { runId: localRunId } })
      await prisma.faultInjectionTask.delete({ where: { id: task.id } })
      await prisma.session.delete({ where: { taskId: localSessionTaskId } }).catch(() => {})
    }
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
