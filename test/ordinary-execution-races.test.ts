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
import test from 'node:test'
import { createIsolatedDatabase } from './helpers/isolated-database'

const database = createIsolatedDatabase()
const { prisma } = require('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma')
const { reserveTraceRetry, reconcileGeneratedTraceCase } = require('@/lib/engine/experiment/trace-generation') as typeof import('@/lib/engine/experiment/trace-generation')
const { generateExperimentTraces } = require('@/lib/engine/experiment/trace-generation') as typeof import('@/lib/engine/experiment/trace-generation')
const { loadCaseExecutionProgress } = require('@/lib/engine/experiment/execution-progress-service') as typeof import('@/lib/engine/experiment/execution-progress-service')
const { executeResultRow, retryResultRow } = require('@/lib/engine/experiment/run-experiment') as typeof import('@/lib/engine/experiment/run-experiment')
const { setFaithfulPresetRunnerForTest } = require('@/lib/engine/experiment/faithful-preset-evaluators') as typeof import('@/lib/engine/experiment/faithful-preset-evaluators')
test.after(async () => { await prisma.$disconnect(); database.dispose() })
test.afterEach(() => setFaithfulPresetRunnerForTest(null))

async function fixture(status = 'failed') {
  const experiment = await prisma.experiment.create({ data: { user: 'race-user', name: 'race', status: 'failed',
    evaluatorIdsJson: '["preset-agent-task-completion"]', cases: { create: { input: 'task', referenceOutput: 'answer' } } }, include: { cases: true } })
  const caseId = experiment.cases[0].id
  const traceId = `trace-${caseId}`
  const execution = await prisma.execution.create({ data: { user: 'race-user', taskId: traceId, finalResult: 'answer', isSubagent: false } })
  await prisma.session.create({ data: { user: 'race-user', taskId: traceId, endTime: new Date(), interactions: '[{"role":"assistant","content":"answer"}]' } })
  await prisma.experimentCase.update({ where: { id: caseId }, data: { taskId: traceId, executionId: execution.id, actualOutput: 'answer' } })
  const attempt = await prisma.experimentTraceAttempt.create({ data: {
    experimentId: experiment.id, caseId, attemptNo: 1, workerId: 'worker', platform: 'opencode', agent: 'build',
    status, traceId, failureCode: status === 'failed' ? 'TRACE_INGEST_TIMEOUT' : null,
  } })
  const result = await prisma.experimentEvalResult.create({ data: { experimentId: experiment.id, caseId, evaluatorId: 'preset-agent-task-completion', status: 'failed' } })
  const request = { user: 'race-user', experimentId: experiment.id, workerId: 'worker', platform: 'opencode', agent: 'build',
    retryFromAttemptId: attempt.id, cases: [{ caseId, input: 'task' }] }
  return { experiment, caseId, execution, attempt, result, request }
}

test('并发重试只预占一个新轮次，且排队快照不保留旧链路和得分', async () => {
  const f = await fixture()
  const results = await Promise.allSettled([reserveTraceRetry(f.request), reserveTraceRetry(f.request)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(await prisma.experimentTraceAttempt.count({ where: { caseId: f.caseId } }), 2)
  const snapshot = (await loadCaseExecutionProgress(f.experiment.id, 'race-user', [f.caseId], ['preset-agent-task-completion'])).get(f.caseId)!
  assert.equal(snapshot.progress.attemptNo, 2)
  assert.equal(snapshot.progress.stage, 0)
  assert.equal(snapshot.progress.status, 'waiting')
  assert.equal(snapshot.executionId, null)
  assert.equal(snapshot.taskId, null)
  assert.equal(snapshot.actualOutput, '')
  assert.deepEqual(snapshot.results, [])
  const row = await prisma.experimentCase.findUniqueOrThrow({ where: { id: f.caseId } })
  assert.equal(row.traceGenerationCommandId, null)
})

test('旧 Trace 晚到不能覆盖最新排队或失败轮次，也不会被历史回收逻辑选中', async () => {
  const f = await fixture()
  const reserved = await reserveTraceRetry(f.request)
  for (const status of ['queued', 'failed', 'cancelled']) {
    await prisma.experimentTraceAttempt.update({ where: { id: reserved[f.caseId] }, data: { status } })
    assert.equal(await reconcileGeneratedTraceCase({ user: 'race-user', caseId: f.caseId }), false)
    const row = await prisma.experimentCase.findUniqueOrThrow({ where: { id: f.caseId } })
    assert.equal(row.taskId, null)
    assert.equal(row.executionId, null)
  }
})

test('Trace 入库只使用当前 attempt，排除子 Agent 并在主记录到达后出现链接', async () => {
  const f = await fixture()
  const reserved = await reserveTraceRetry(f.request)
  const traceId = `new-${f.caseId}`
  await prisma.experimentTraceAttempt.update({ where: { id: reserved[f.caseId] }, data: { traceId, status: 'waiting_trace' } })
  await prisma.execution.create({ data: { user: 'race-user', taskId: traceId, isSubagent: true } })
  let snapshot = (await loadCaseExecutionProgress(f.experiment.id, 'race-user', [f.caseId], [])).get(f.caseId)!
  assert.equal(snapshot.executionId, null)
  const root = await prisma.execution.create({ data: { user: 'race-user', taskId: traceId, isSubagent: false } })
  snapshot = (await loadCaseExecutionProgress(f.experiment.id, 'race-user', [f.caseId], [])).get(f.caseId)!
  assert.equal(snapshot.progress.stage, 2)
  assert.equal(snapshot.executionId, root.id)
  assert.equal(snapshot.taskId, traceId)
})

for (const reused of [false, true]) {
  test(`预占的重试轮次可执行，${reused ? '拒绝历史 Trace 标识' : '准确绑定新主链路'}`, async () => {
    const f = await fixture()
    await prisma.reliabilityClient.upsert({ where: { clientId: 'worker' }, create: { clientId: 'worker', user: 'race-user', name: 'worker', lastSeenAt: new Date() }, update: {} })
    const reservedAttemptIds = await reserveTraceRetry(f.request)
    const controller = new AbortController()
    const work = generateExperimentTraces({ ...f.request, signal: controller.signal }, { forceNewTrace: true, reservedAttemptIds })
    try {
      let commandId: string | null = null
      for (let count = 0; count < 100 && !commandId; count++) {
        commandId = (await prisma.experimentTraceAttempt.findUniqueOrThrow({ where: { id: reservedAttemptIds[f.caseId] } })).commandId
        if (!commandId) await new Promise(resolve => setTimeout(resolve, 20))
      }
      assert.ok(commandId)
      const progress = async () => (await loadCaseExecutionProgress(f.experiment.id, 'race-user', [f.caseId], [])).get(f.caseId)!.progress
      assert.equal((await progress()).stage, 0, '下发成功不能假定客户端已经开始执行')
      await prisma.reliabilityCommand.update({ where: { commandId }, data: { status: 'RUNNING' } })
      assert.equal((await progress()).stage, 1, '客户端上报 RUNNING 后进入 Agent 执行阶段')
      const traceId = reused ? f.attempt.traceId! : `fresh-${f.caseId}`
      if (!reused) {
        await prisma.execution.create({ data: { user: 'race-user', taskId: traceId, finalResult: 'fresh', isSubagent: false } })
        await prisma.session.create({ data: { user: 'race-user', taskId: traceId, endTime: new Date(), interactions: '[{"role":"assistant","content":"fresh"}]' } })
      }
      await prisma.reliabilityCommand.update({ where: { commandId }, data: { status: 'SUCCEEDED', resultJson: JSON.stringify({ traceId }) } })
      const outcome = await work
      assert.equal(outcome.readyCaseIds.length, reused ? 0 : 1)
      assert.equal(await prisma.experimentTraceAttempt.count({ where: { caseId: f.caseId } }), 2)
      const current = await prisma.experimentTraceAttempt.findUniqueOrThrow({ where: { id: reservedAttemptIds[f.caseId] } })
      assert.equal(current.status, reused ? 'failed' : 'ready')
      const row = await prisma.experimentCase.findUniqueOrThrow({ where: { id: f.caseId } })
      assert.equal(row.taskId, reused ? null : traceId)
      assert.equal(current.failureCode, reused ? 'TRACE_ID_REUSED' : null)
    } finally { controller.abort(); await work.catch(() => undefined) }
  })
}

for (const mode of ['execute', 'evaluate']) {
  test(`迟到评测不会覆盖新的${mode === 'execute' ? '执行' : '评测'}轮次`, async () => {
    const f = await fixture('ready')
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    let calls = 0
    setFaithfulPresetRunnerForTest(async () => {
      if (++calls === 1) { entered(); await gate }
      return { score: calls === 1 ? 10 : 90, points: [], evidence: { md: 'fixture' } }
    })
    const old = executeResultRow('race-user', f.result.id)
    try {
      await started
      await prisma.experimentEvalResult.update({ where: { id: f.result.id }, data: { status: 'failed', errorMessage: 'expired' } })
      if (mode === 'execute') await reserveTraceRetry(f.request)
      else await retryResultRow(f.experiment.id, f.result.id, 'race-user')
      const before = await prisma.experimentEvalResult.findUniqueOrThrow({ where: { id: f.result.id } })
      release()
      await old
      const after = await prisma.experimentEvalResult.findUniqueOrThrow({ where: { id: f.result.id } })
      assert.equal(after.status, before.status)
      assert.equal(after.score, before.score)
      assert.equal(after.attempts, before.attempts)
      assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime())
    } finally { release(); await old }
  })
}
