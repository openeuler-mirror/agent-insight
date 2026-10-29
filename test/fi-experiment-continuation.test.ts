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

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { ExperimentEvalResult } from '@prisma/client'

let prisma: typeof import('@/lib/storage/prisma')['prisma']
let continuation: typeof import('@/lib/engine/experiment/fi-experiment-continuation')
let setJudge: typeof import('@/lib/engine/experiment/judge-llm')['setJudgeLlmCallerForTest']
let root: string
let sequence = 0
let calls = 0
const user = 'fi-continuation-test'
const evaluatorId = 'preset-ras-reliability-detection-recovery'

/** Persist FI intent and optional business traces without starting any Agent process. */
async function fixture(kinds: string[] = ['ready']) {
  const experiment = await prisma.experiment.create({ data: {
    user, name: 'resume test', status: 'running', agentName: 'build',
    evaluatorIdsJson: JSON.stringify([evaluatorId]),
    configSnapshotJson: JSON.stringify({ traceSource: 'generate', fiOrchestrate: true }),
  } })
  const cases = []
  const runs = []
  for (const kind of kinds) {
    const tag = String(++sequence)
    const taskId = 'ses_recovery_' + tag
    const run = await prisma.faultInjectionRun.create({ data: {
      user, runId: 'ras-recovery-' + tag, platform: 'opencode', agent: 'build',
      fault: 'thinking-dead-loop', status: kind === 'queued' ? 'queued' : 'completed',
      sessionTaskId: kind === 'queued' ? null : taskId, updatedAt: new Date(0),
    } })
    const row = await prisma.experimentCase.create({ data: {
      experimentId: experiment.id, input: 'test fault', faultInjectionType: 'thinking-dead-loop', fiRunId: run.runId,
    } })
    if (kind !== 'queued') {
      await prisma.execution.create({ data: { user, taskId, framework: 'opencode', agentName: 'build' } })
      await prisma.session.create({ data: {
        user, taskId, endTime: new Date(), interactions: JSON.stringify([
          { role: 'user', content: 'test fault' },
          { role: 'assistant', content: kind === 'empty' ? '' : 'fault observed and recovered' },
        ]),
      } })
    }
    cases.push(row)
    runs.push(run)
  }
  return { experiment, cases, runs }
}

test.before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fi-continuation-'))
  process.env.AGENT_INSIGHT_HOME = root
  process.env.DATABASE_URL = 'file:' + path.join(root, 'test.db')
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' })
  ;({ prisma } = await import('@/lib/storage/prisma'))
  ;({ setJudgeLlmCallerForTest: setJudge } = await import('@/lib/engine/experiment/judge-llm'))
  continuation = await import('@/lib/engine/experiment/fi-experiment-continuation')
})
test.beforeEach(() => {
  calls = 0
  setJudge(async () => {
    calls++
    return JSON.stringify({
      summary: '预期故障发生，完成检测、处置和恢复。',
      faultOccurred: { verdict: 'met', reason: 'confirmed', suggestion: '' },
      dimensions: ['fault_detected', 'mitigation_triggered', 'fault_mitigated'].map((dimension) => ({
        dimension, verdict: 'met', reason: 'confirmed', suggestion: '',
      })),
    })
  })
})
test.after(async () => {
  setJudge(null)
  await prisma?.$disconnect()
  if (root) rmSync(root, { recursive: true, force: true })
})

test('startup recovery binds valid traces, skips empty traces and starts the selected evaluator once', async () => {
  const f = await fixture(['ready', 'empty'])
  const before = await prisma.faultInjectionRun.count()
  assert.equal(await continuation.resumeFiExperimentContinuations(), 1)
  const first = continuation.ensureFiExperimentContinuation(f.experiment.id, user)
  assert.equal(continuation.ensureFiExperimentContinuation(f.experiment.id, user), first)
  await first
  assert.equal(calls, 1)
  const results = await prisma.experimentEvalResult.findMany({ where: { experimentId: f.experiment.id } })
  assert.equal(results.length, 1)
  assert.equal(results[0].status, 'done')
  assert.equal(results[0].score, 100)
  assert.equal((await prisma.experiment.findUniqueOrThrow({ where: { id: f.experiment.id } })).status, 'partial')
  assert.ok((await prisma.experimentCase.findUniqueOrThrow({ where: { id: f.cases[1].id } })).traceGenerationError)
  assert.equal(await prisma.faultInjectionRun.count(), before)
  assert.equal(await continuation.resumeFiExperimentContinuations(), 0)
})

test('resuming evaluation preserves terminal results and human edits, retrying only missing/pending/interrupted rows', async () => {
  const f = await fixture(['ready', 'ready', 'ready', 'ready', 'ready'])
  const statuses = ['done', 'failed', 'pending', 'running']
  const saved = []
  for (const [index, status] of statuses.entries()) {
    saved.push(await prisma.experimentEvalResult.create({ data: {
      experimentId: f.experiment.id, caseId: f.cases[index].id, evaluatorId, status,
      summary: 'original ' + status, score: 50, attempts: 2, errorMessage: 'original error',
      humanScore: 88, humanReason: 'reviewed', humanBy: 'reviewer', humanAt: new Date(1000),
    } }))
  }
  await continuation.ensureFiExperimentContinuation(f.experiment.id, user)
  assert.equal(calls, 3)
  const rows: ExperimentEvalResult[] = await prisma.experimentEvalResult.findMany({ where: { experimentId: f.experiment.id } })
  assert.equal(rows.length, 5)
  for (const original of saved.slice(0, 2)) {
    assert.deepEqual(rows.find((r) => r.id === original.id), original)
  }
  for (const original of saved.slice(2)) {
    const row = rows.find((r) => r.id === original.id)!
    assert.equal(row.status, 'done')
    assert.equal(row.attempts, 3)
    assert.equal(row.humanScore, 88)
    assert.equal(row.humanReason, 'reviewed')
    assert.equal(row.humanBy, 'reviewer')
    assert.equal(row.humanAt?.getTime(), 1000)
  }
})

test('queued FI work continues waiting after recovery and can bind a later trace', async () => {
  const f = await fixture(['queued'])
  const pending = continuation.ensureFiExperimentContinuation(f.experiment.id, user)
  assert.equal(await continuation.resumeFiExperimentContinuations(), 0)
  const taskId = 'ses_recovered_late'
  await prisma.execution.create({ data: { user, taskId, framework: 'opencode', agentName: 'build' } })
  await prisma.session.create({ data: { user, taskId, endTime: new Date(), interactions: '[{"role":"assistant","content":"done"}]' } })
  await prisma.faultInjectionRun.update({ where: { id: f.runs[0].id }, data: { status: 'completed', sessionTaskId: taskId } })
  await pending
  assert.equal(calls, 1)
  assert.ok((await prisma.experimentCase.findUniqueOrThrow({ where: { id: f.cases[0].id } })).executionId)
})

test('all unusable traces settle as failed without invoking a model', async () => {
  const f = await fixture(['empty'])
  await continuation.ensureFiExperimentContinuation(f.experiment.id, user)
  assert.equal(calls, 0)
  assert.equal((await prisma.experiment.findUniqueOrThrow({ where: { id: f.experiment.id } })).status, 'failed')
  assert.equal(await prisma.experimentEvalResult.count({ where: { experimentId: f.experiment.id } }), 0)
})

test('cancelled/deleted/ordinary experiments are excluded from automatic recovery', async () => {
  const cancelled = await fixture()
  const deleted = await fixture()
  const ordinary = await fixture()
  await prisma.experiment.update({ where: { id: cancelled.experiment.id }, data: { status: 'cancelled' } })
  await prisma.experiment.update({ where: { id: deleted.experiment.id }, data: { deletedAt: new Date() } })
  await prisma.experiment.update({ where: { id: ordinary.experiment.id }, data: { configSnapshotJson: '{}' } })
  assert.equal(await continuation.resumeFiExperimentContinuations(), 0)
  for (const f of [cancelled, deleted, ordinary]) await continuation.ensureFiExperimentContinuation(f.experiment.id, user)
  assert.equal(calls, 0)
  assert.equal(await prisma.experimentEvalResult.count({ where: { experimentId: { in: [cancelled, deleted, ordinary].map((f) => f.experiment.id) } } }), 0)
})

test('cancelling while the restored continuation waits prevents evaluation', async () => {
  const f = await fixture(['queued'])
  const pending = continuation.ensureFiExperimentContinuation(f.experiment.id, user)
  await prisma.experiment.update({ where: { id: f.experiment.id }, data: { status: 'cancelled' } })
  await pending
  assert.equal(calls, 0)
  assert.equal(await prisma.experimentEvalResult.count({ where: { experimentId: f.experiment.id } }), 0)
})
