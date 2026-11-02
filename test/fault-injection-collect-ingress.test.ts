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

/** FI ingress integration: no implicit model calls, independent traces and historical compatibility. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

let prisma: typeof import('@/lib/storage/prisma')['prisma']
let collect: typeof import('@/app/api/fault-injection/runs/[runId]/collect-result/route')['POST']
let trace: typeof import('@/app/api/fault-injection/runs/[runId]/trace/route')['GET']
let rejudge: typeof import('@/app/api/fault-injection/runs/[runId]/rejudge/route')['POST']
let root: string
let sequence = 0
const user = 'fi-collect-ingress-' + process.pid
const apiKey = 'fi-collect-ingress-test-key'

test.before(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fi-collect-ingress-'))
  process.env.AGENT_INSIGHT_HOME = root
  process.env.DATABASE_URL = 'file:' + path.join(root, 'test.db')
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--skip-generate'], { env: process.env, stdio: 'pipe' })
  ;({ prisma } = await import('@/lib/storage/prisma'))
  ;({ POST: collect } = await import('@/app/api/fault-injection/runs/[runId]/collect-result/route'))
  ;({ GET: trace } = await import('@/app/api/fault-injection/runs/[runId]/trace/route'))
  ;({ POST: rejudge } = await import('@/app/api/fault-injection/runs/[runId]/rejudge/route'))
  await prisma.user.create({ data: { username: user, apiKey } })
})
test.after(async () => {
  await prisma?.$disconnect()
  if (root) rmSync(root, { recursive: true, force: true })
})

/** Create an actual collecting Run and its experiment Case without a catalog or model. */
async function fixture() {
  const tag = String(++sequence)
  const experiment = await prisma.experiment.create({ data: {
    user, name: 'FI collect ' + tag, agentName: 'build', status: 'running',
    evaluatorIdsJson: '["preset-ras-reliability-detection-recovery"]',
  } })
  const task = await prisma.faultInjectionTask.create({ data: {
    taskKey: 'task-fi-ingress-' + tag, name: 'FI collect ' + tag, user,
    platform: 'opencode', agent: 'build', prompt: 'run', workspace: '/tmp',
    status: 'running', itemsJson: '[]',
  } })
  const run = await prisma.faultInjectionRun.create({ data: {
    user, fiTaskId: task.id, runId: 'ras-fi-ingress-' + tag, platform: 'opencode',
    agent: 'build', fault: 'step-omission', status: 'collecting',
    requestJson: '{"model":"test/provider-model"}',
  } })
  const row = await prisma.experimentCase.create({ data: {
    experimentId: experiment.id, input: 'run', fiRunId: run.runId, faultInjectionType: run.fault,
  } })
  return { run, task, row, sessionId: 'ses_fi_ingress_' + tag }
}

/** Submit a real worker-authenticated collection response. */
function upload(runId: string, body: Record<string, unknown>) {
  return collect(new Request('http://localhost/api/fault-injection/runs/' + runId + '/collect-result', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-witty-api-key': apiKey },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ runId }) })
}

for (const faultActivated of [true, false]) {
  test('collection finishes without model requests or waiting for late Trace; activated=' + faultActivated, async () => {
    const data = await fixture()
    const realFetch = globalThis.fetch
    let networkCalls = 0
    globalThis.fetch = async () => { networkCalls++; throw new Error('FI collection must not call a model') }
    let response: Response
    try {
      response = await upload(data.run.runId, {
        taskId: data.sessionId, sessionAligned: true, faultActivated,
        injectionMethod: 'skill_inject', interactions: [{ role: 'assistant', content: 'untrusted trace' }],
        markers: [
          { id: 'activation', kind: 'fault_activation', label: 'Fault activation completed' },
          { id: 'fake-judge', kind: 'evaluation', label: 'Evaluation completed' },
        ],
      })
    } finally { globalThis.fetch = realFetch }
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'completed')
    assert.equal(networkCalls, 0)
    const saved = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: data.run.id } })
    assert.equal(saved.faultActivated, faultActivated)
    assert.equal(saved.judgedAt, null)
    assert.equal(saved.judgeRawJson, null)
    assert.equal(saved.outcome, null)
    assert.deepEqual(JSON.parse(saved.markersJson || '[]').map((m: { id: string }) => m.id), ['activation'])
    assert.equal((await prisma.faultInjectionTask.findUniqueOrThrow({ where: { id: data.task.id } })).status, 'completed')
    assert.equal(await prisma.session.findUnique({ where: { taskId: data.sessionId } }), null)
    assert.equal(await prisma.execution.count({ where: { taskId: data.sessionId } }), 0)
    assert.equal((await prisma.experimentCase.findUniqueOrThrow({ where: { id: data.row.id } })).executionId, null)

    const messages = [{ role: 'assistant', content: 'independent business trace' }]
    await prisma.session.create({ data: { user, taskId: data.sessionId, interactions: JSON.stringify(messages), endTime: new Date() } })
    await prisma.execution.create({ data: { user, taskId: data.sessionId, agentName: 'build', framework: 'opencode' } })
    const { awaitFiSessionsAndBindExperimentCases } = await import('@/lib/engine/experiment/fi-orchestrate')
    const bound = await awaitFiSessionsAndBindExperimentCases({ runIds: [saved.runId], waitForActiveRuns: true })
    assert.deepEqual(bound.readyRunIds, [saved.runId])
    assert.ok((await prisma.experimentCase.findUniqueOrThrow({ where: { id: data.row.id } })).executionId)
    assert.deepEqual(JSON.parse((await prisma.session.findUniqueOrThrow({ where: { taskId: data.sessionId } })).interactions!), messages)

    const viewed = await trace(new Request('http://localhost/api/fault-injection/runs/' + saved.runId + '/trace?user=' + user),
      { params: Promise.resolve({ runId: saved.runId }) })
    const body = await viewed.json()
    assert.equal(body.judge, null)
    assert.equal(body.markers.some((m: { kind: string }) => m.kind === 'evaluation'), false)
    assert.equal(body.rasMarkers.length, 0)
  })
}

test('ingress never overwrites an independently uploaded business Session and binds it immediately', async () => {
  const data = await fixture()
  const messages = [{ role: 'assistant', content: 'independent response stays intact' }]
  await prisma.session.create({ data: { user, taskId: data.sessionId, interactions: JSON.stringify(messages), endTime: new Date() } })
  const execution = await prisma.execution.create({ data: { user, taskId: data.sessionId, agentName: 'build', framework: 'opencode' } })
  const response = await upload(data.run.runId, {
    taskId: data.sessionId, faultActivated: true,
    interactions: [{ role: 'assistant', content: 'FI must not replace the main trace' }],
    markers: [{ kind: 'fault_activation', label: 'Fault activation completed' }],
  })
  assert.equal((await response.json()).status, 'completed')
  assert.equal((await prisma.experimentCase.findUniqueOrThrow({ where: { id: data.row.id } })).executionId, execution.id)
  assert.deepEqual(JSON.parse((await prisma.session.findUniqueOrThrow({ where: { taskId: data.sessionId } })).interactions!), messages)
})

test('startup failures and missing Session identities stay failed; stop remains terminal', async () => {
  const startup = await fixture()
  await upload(startup.run.runId, { error: 'plugin_start_failed: plugin not ready', interactions: [] })
  const failed = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: startup.run.id } })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error!, /plugin_start_failed/)
  const unaligned = await fixture()
  await upload(unaligned.run.runId, { taskId: unaligned.run.runId, faultActivated: true })
  const invalid = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: unaligned.run.id } })
  assert.equal(invalid.status, 'failed')
  assert.match(invalid.error!, /session_unaligned/)
  const stopped = await fixture()
  const result = await upload(stopped.run.runId, { taskId: stopped.sessionId, stopped: true, faultActivated: true })
  assert.equal((await result.json()).status, 'stopped')
  assert.equal((await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: stopped.run.id } })).status, 'stopped')
})

test('legacy FI judgments remain readable, while rejudge returns 410 without modifying them', async () => {
  const data = await fixture()
  const judgedAt = new Date()
  const marker = { kind: 'evaluation', label: 'Evaluation completed', payload: { outcome: 'occurred', reason: 'historical verdict' } }
  await prisma.faultInjectionRun.update({ where: { id: data.run.id }, data: {
    status: 'completed', outcome: 'occurred', faultContainmentStatus: 'recovered',
    judgeReason: 'historical verdict', judgeRawJson: '{"raw":"historical"}', judgedAt,
    markersJson: JSON.stringify([marker]),
  } })
  const before = await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: data.run.id } })
  const response = await rejudge(new Request('http://localhost/api/fault-injection/runs/' + data.run.runId + '/rejudge?user=' + user, { method: 'POST' }))
  assert.equal(response.status, 410)
  assert.equal((await response.json()).code, 'FI_JUDGE_REMOVED')
  assert.deepEqual(await prisma.faultInjectionRun.findUniqueOrThrow({ where: { id: data.run.id } }), before)
  const viewed = await trace(new Request('http://localhost/api/fault-injection/runs/' + data.run.runId + '/trace?user=' + user),
    { params: Promise.resolve({ runId: data.run.runId }) })
  const body = await viewed.json()
  assert.deepEqual(body.judge, { outcome: 'occurred', faultContainmentStatus: 'recovered', reason: 'historical verdict' })
  assert.equal(body.markers.some((m: { kind: string }) => m.kind === 'evaluation'), true)
})
