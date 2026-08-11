/**
 * FI Judge / Run must read Prisma after collect ingress — not the upload body.
 */
import assert from 'node:assert/strict'
import { describe, it, after } from 'node:test'
import { prisma } from '../src/lib/storage/prisma'
import type { CollectPayload } from '../src/lib/fault-injection/engine'
import {
  finishFiJudgeFromDb,
  loadPersistedFiCollectForJudge,
  newRunId,
  newTaskKey,
  persistFiCollectIngress,
} from '../src/lib/fault-injection/store'

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

    const payload: CollectPayload = {
      runId,
      taskId: sessionTaskId,
      framework: 'opencode',
      fault: 'step-omission',
      injectionMethod: 'skill_inject',
      faultActivated: false,
      interactions: [
        { role: 'user', content: 'from-upload', timestamp: 1 },
        { role: 'assistant', content: 'from-upload-a', timestamp: 2 },
      ],
      markers: [{ id: 'marker-from-upload', kind: 'fault_activation', label: 'upload' }],
    }

    await persistFiCollectIngress({ runId, user, payload })

    // Mutate persisted rows after ingress — Judge must see these, not the upload body.
    const dbInteractions = [
      { role: 'user', content: 'from-db', timestamp: 10 },
      { role: 'assistant', content: 'from-db-a', timestamp: 20 },
    ]
    await prisma.session.update({
      where: { taskId: sessionTaskId },
      data: { interactions: JSON.stringify(dbInteractions) },
    })
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

  after(async () => {
    if (runId) await prisma.faultInjectionRun.deleteMany({ where: { runId } }).catch(() => {})
    if (taskId) await prisma.faultInjectionTask.delete({ where: { id: taskId } }).catch(() => {})
    if (sessionTaskId) {
      await prisma.session.delete({ where: { taskId: sessionTaskId } }).catch(() => {})
    }
    await prisma.$disconnect()
  })
})
