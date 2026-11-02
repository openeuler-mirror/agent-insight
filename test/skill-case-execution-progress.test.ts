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
import Module, { createRequire } from 'node:module'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SkillCaseExecutionProgress } from '@/components/skill-workbench/SkillCaseExecutionProgress'
import { randomUUID } from 'node:crypto'
import { NextRequest } from 'next/server'
import { createIsolatedDatabase } from './helpers/isolated-database'
import { acceptSkillRunProgress, acceptSkillSnapshot, type SkillRunProgress } from '@/lib/skill-workbench/execution-progress'
import { canWriteRunProgress } from '@/lib/grayscale/run-progress'

const database = createIsolatedDatabase()
const loadModule = createRequire(import.meta.url)
const { prisma } = loadModule('@/lib/storage/prisma') as typeof import('@/lib/storage/prisma')
const { commitRunProgress } = loadModule('@/lib/grayscale/run-progress-store') as typeof import('@/lib/grayscale/run-progress-store')
const { loadSkillExecutionProgress } = loadModule('@/lib/skill-workbench/execution-progress-service') as typeof import('@/lib/skill-workbench/execution-progress-service')
const { ownsSkillExecution } = loadModule('@/lib/grayscale/execution-fence') as typeof import('@/lib/grayscale/execution-fence')
const { generateExperimentTraces } = loadModule('@/lib/engine/experiment/trace-generation') as typeof import('@/lib/engine/experiment/trace-generation')
test.after(async () => { await prisma.$disconnect(); database.dispose() })
const user = 'skill-progress-test'
const slot = (claim = 'first') => ({ caseId: 'dataset-case', roundIndex: 1, runIndex: 1, status: 'running', executionGeneration: 1, executionClaimId: claim, progressRevision: 1 })
async function fixture(preset = 'skill-ab') {
  const a = slot('a'), b = slot('b')
  const task = await prisma.grayscaleTask.create({ data: { user, skillId: 'skill', skillName: 'skill', skillVersion: 1, skillVersionId: 'v1', taskName: randomUUID(), configJson: '{}', caseStatesJson: JSON.stringify({ 'dataset-case': { a: { runs: [a] }, b: { runs: [b] } } }) } })
  const experiment = await prisma.experiment.create({ data: { user, name: 'Skill progress', scope: 'skill-workbench', preset, status: 'running', evaluatorIdsJson: '["judge"]', configSnapshotJson: JSON.stringify({ grayscaleTaskId: task.id, caseIds: ['dataset-case'], executionSides: preset === 'skill-ab' ? ['a', 'b'] : ['b'], repeatRounds: 1, traceSource: 'generate' }) } })
  return { task, experiment, a, b }
}
const commit = (taskId: string, side: 'a' | 'b', nextRun: ReturnType<typeof slot>, extra = {}) => commitRunProgress({ taskId, user, caseId: 'dataset-case', side, nextRun, aggregate: state => state, ...extra })
async function read(taskId: string) { return JSON.parse((await prisma.grayscaleTask.findUniqueOrThrow({ where: { id: taskId } })).caseStatesJson)['dataset-case'] }

function progress(patch: Partial<SkillRunProgress> = {}): SkillRunProgress {
  return { identity: 'slot:attempt', stateRevision: 1, experimentCaseId: 'case', datasetCaseId: 'dataset-case', side: 'b', runIndex: 1, roundIndex: 1, executionGeneration: 1, executionClaimId: 'b', traceAttemptNo: 1, attemptNo: 1, generation: 1, revision: 100, evaluationVersion: 1, source: 'generated', stage: 1, status: 'running', label: 'Agent 执行中', startedAt: new Date(0).toISOString(), updatedAt: new Date(100).toISOString(), finishedAt: null, traceId: null, executionId: null, error: null, evaluators: [], ...patch }
}

test('A/B 两侧并发提交不丢失，旧阶段和旧执行回调不能覆盖新轮', async () => {
  const f = await fixture()
  assert.ok((await Promise.all([commit(f.task.id, 'a', { ...f.a, status: 'executed' }), commit(f.task.id, 'b', { ...f.b, status: 'executed' })])).every(Boolean))
  let states = await read(f.task.id)
  assert.equal(states.a.runs[0].status, 'executed'); assert.equal(states.b.runs[0].status, 'executed')
  assert.equal(await commit(f.task.id, 'b', f.b), null)
  const current = states.b.runs[0]
  const replacements = await Promise.all(['retry-one', 'retry-two'].map(claim => commit(f.task.id, 'b', { ...current, status: 'pending', executionGeneration: 2, executionClaimId: claim }, { replaceExecution: true, expectedExecutionClaimId: 'b' })))
  assert.equal(replacements.filter(Boolean).length, 1)
  assert.equal(await commit(f.task.id, 'b', { ...current, status: 'pass' }), null)
  states = await read(f.task.id)
  const fence = { taskId: f.task.id, user, datasetCaseId: 'dataset-case', side: 'b' as const, runIndex: 1, executionClaimId: states.b.runs[0].executionClaimId }
  assert.equal(await ownsSkillExecution(prisma, fence), true)
  assert.equal(await ownsSkillExecution(prisma, { ...fence, executionClaimId: 'b' }), false)
  assert.equal(states.a.runs[0].status, 'executed')
})

test('仅重新评测保留执行身份和根链路，旧评测 claim 不得覆盖', async () => {
  const current = { ...slot(), status: 'fail', evaluationAttempts: 1, evaluationClaimId: 'judge-old', sessionId: 'root' }
  const next = { ...current, status: 'evaluating', evaluationAttempts: 2, evaluationClaimId: 'judge-new' }
  assert.equal(canWriteRunProgress(current, next), true)
  assert.equal(canWriteRunProgress(next, { ...current, status: 'pass' }), false)
  assert.equal(canWriteRunProgress(next, { ...next, sessionId: 'wrong-root' }), false)
  const f = await fixture()
  const first = await commit(f.task.id, 'b', { ...f.b, ...current, executionClaimId: 'b' })
  assert.ok(first)
  const second = await commit(f.task.id, 'b', { ...first.run, ...next, progressRevision: first.run.progressRevision, executionClaimId: 'b' })
  assert.ok(second)
  assert.equal((second.run as typeof next).sessionId, 'root')
  assert.equal(await commit(f.task.id, 'b', { ...first.run, status: 'pass' }), null)
})

test('客户端快照拒绝旧轮、旧 Attempt、低 revision 和阶段回退，允许真实重试和重评', () => {
  const done = progress({ stage: 4, status: 'done', traceId: 'root', executionId: 'execution', stateRevision: 5 })
  assert.equal(acceptSkillRunProgress(done, progress({ revision: 200, stateRevision: 6 })), done)
  assert.equal(acceptSkillRunProgress(done, progress({ stateRevision: 4, stage: 4, status: 'done', revision: 200 })), done)
  const retry = progress({ identity: 'new:pending', traceAttemptNo: 0, attemptNo: 1, executionGeneration: 2, executionClaimId: 'new', stateRevision: 6, stage: 0, status: 'waiting', revision: 0 })
  assert.equal(acceptSkillRunProgress(done, retry), retry)
  assert.equal(acceptSkillRunProgress(retry, done), retry)
  const pinned = { ...retry, identity: 'new:attempt', traceAttemptNo: 2, stage: 1, status: 'running' as const }
  assert.equal(acceptSkillRunProgress(retry, pinned), pinned)
  assert.equal(acceptSkillRunProgress(pinned, retry), pinned)
  const reevaluation = { ...done, stateRevision: 6, evaluationVersion: 2, stage: 3, status: 'running' as const, revision: 1 }
  assert.equal(acceptSkillRunProgress(done, reevaluation).stage, 3)
  assert.equal(acceptSkillRunProgress(done, reevaluation).traceId, 'root')
  const old = { taskId: 'task', caseStates: { 'dataset-case': { b: { runs: [{ runIndex: 1, roundIndex: 1, status: 'pass' as const }] } } }, progress: { 'dataset-case': { b: [done] } } }
  const merged = acceptSkillSnapshot(old, { ...old, caseStates: { 'dataset-case': { b: { runs: [{ runIndex: 1, roundIndex: 1, status: 'running' }] } } }, progress: { 'dataset-case': { a: [progress({ side: 'a' })], b: [progress()] } } })
  assert.equal(merged.caseStates['dataset-case'].b?.runs?.[0].status, 'pass')
  assert.equal(merged.progress['dataset-case'].a?.[0].status, 'running')
})

test('触发、用例、A/B 在执行中关联当前根链路，重试预占后隐藏旧根及旧 Attempt', async () => {
  for (const preset of ['trigger', 'use-case', 'skill-ab']) {
    const f = await fixture(preset)
    const caseRow = await prisma.experimentCase.create({ data: { experimentId: f.experiment.id, input: 'query' } })
    const attempt = await prisma.experimentTraceAttempt.create({ data: { experimentId: f.experiment.id, caseId: caseRow.id, attemptNo: 1, workerId: 'client', platform: 'opencode', agent: 'build', status: 'running', traceId: randomUUID() } })
    const states = await read(f.task.id)
    Object.assign(states.b.runs[0], { experimentCaseId: caseRow.id, traceAttemptId: attempt.id, traceAttemptNo: 1 })
    await prisma.grayscaleTask.update({ where: { id: f.task.id }, data: { caseStatesJson: JSON.stringify({ 'dataset-case': states }) } })
    let snapshot = await loadSkillExecutionProgress(f.experiment.id, user)
    assert.equal(snapshot?.progress['dataset-case'].b?.[0].traceId, attempt.traceId)
    assert.equal(snapshot?.progress['dataset-case'].b?.[0].executionId, null)
    const execution = await prisma.execution.create({ data: { user, taskId: attempt.traceId!, agentName: 'build', isSubagent: false, timestamp: new Date() } })
    snapshot = await loadSkillExecutionProgress(f.experiment.id, user)
    assert.equal(snapshot?.progress['dataset-case'].b?.[0].executionId, execution.id)
    assert.equal(snapshot?.progress['dataset-case'].b?.[0].status, 'waiting')
    const current = states.b.runs[0]
    await commit(f.task.id, 'b', { ...current, status: 'pending', executionGeneration: 2, executionClaimId: 'new', traceAttemptId: undefined, traceAttemptNo: undefined }, { replaceExecution: true, expectedExecutionClaimId: 'b' })
    snapshot = await loadSkillExecutionProgress(f.experiment.id, user)
    assert.equal(snapshot?.progress['dataset-case'].b?.[0].traceId, null)
    assert.equal(snapshot?.progress['dataset-case'].b?.[0].executionId, null)
    assert.equal(snapshot?.progress['dataset-case'].b?.[0].stage, 0)
  }
})

test('Skill 触发、用例与 A/B 提前关联根链路后的模型错误均显示 Agent 执行失败', async () => {
  const clientId = randomUUID()
  await prisma.reliabilityClient.create({ data: { clientId, user, name: 'fixture', lastSeenAt: new Date() } })
  for (const preset of ['trigger', 'use-case', 'skill-ab']) {
    const f = await fixture(preset)
    const row = await prisma.experimentCase.create({ data: { experimentId: f.experiment.id, input: 'query' } })
    const traceId = randomUUID(), commandId = randomUUID()
    await prisma.reliabilityCommand.create({ data: { commandId, clientId, user, action: 'RUN_EXPERIMENT_CASE', status: 'FAILED', errorCode: 'MODEL_ERROR', expiresAt: new Date(Date.now() + 600000) } })
    const attempt = await prisma.experimentTraceAttempt.create({ data: { experimentId: f.experiment.id, caseId: row.id, attemptNo: 1, workerId: clientId, platform: 'opencode', agent: 'build', status: 'failed', commandId, traceId, failureCode: 'MODEL_ERROR', errorMessage: 'model not found' } })
    const execution = await prisma.execution.create({ data: { user, taskId: traceId, agentName: 'build', isSubagent: false, timestamp: new Date() } })
    const states = await read(f.task.id)
    Object.assign(states.b.runs[0], { experimentCaseId: row.id, traceAttemptId: attempt.id, traceAttemptNo: 1, status: 'failed', failureType: 'execution_error', failureDetail: 'model not found' })
    await prisma.grayscaleTask.update({ where: { id: f.task.id }, data: { caseStatesJson: JSON.stringify({ 'dataset-case': states }) } })
    const snapshot = (await loadSkillExecutionProgress(f.experiment.id, user))!.progress['dataset-case'].b![0]
    assert.equal(snapshot.stage, 1, preset)
    assert.equal(snapshot.status, 'failed')
    assert.equal(snapshot.error, 'model not found')
    assert.equal(snapshot.executionId, execution.id)
    assert.equal(snapshot.traceId, traceId)
    if (preset === 'skill-ab') assert.equal((await loadSkillExecutionProgress(f.experiment.id, user))!.progress['dataset-case'].a![0].stage, 0)
  }
})

test('执行身份丢失时不下发指令，也不改写新轮 Case 的失败原因', async () => {
  const f = await fixture('use-case')
  const commandsBefore = await prisma.reliabilityCommand.count()
  const caseRow = await prisma.experimentCase.create({ data: { experimentId: f.experiment.id, input: 'query', traceGenerationError: 'new-round-error', actualOutput: 'new-output' } })
  const result = await generateExperimentTraces({ user, experimentId: f.experiment.id, workerId: 'unavailable', platform: 'opencode', agent: 'build', timeoutSeconds: 1, cases: [{ caseId: caseRow.id, input: 'query' }], skillExecution: { version: 1, skill: null }, skillRun: { taskId: f.task.id, user, datasetCaseId: 'dataset-case', side: 'b', runIndex: 1, executionClaimId: 'b' }, onAttemptCreated: async () => { const states = await read(f.task.id); states.b.runs[0].executionClaimId = 'new'; await prisma.grayscaleTask.update({ where: { id: f.task.id }, data: { caseStatesJson: JSON.stringify({ 'dataset-case': states }) } }); return false } }, { forceNewTrace: true })
  assert.deepEqual(result.readyCaseIds, [])
  assert.equal(await prisma.reliabilityCommand.count(), commandsBefore)
  const row = await prisma.experimentCase.findUniqueOrThrow({ where: { id: caseRow.id } })
  assert.equal(row.actualOutput, 'new-output')
  assert.equal(row.traceGenerationError, 'new-round-error')
})


test('迟到旧执行不能创建更高序号的 Trace Attempt', async () => {
  const f = await fixture('use-case')
  const row = await prisma.experimentCase.create({ data: { experimentId: f.experiment.id, input: 'query' } })
  await assert.rejects(generateExperimentTraces({ user, experimentId: f.experiment.id, workerId: 'client', platform: 'opencode', agent: 'build', cases: [{ caseId: row.id, input: 'query' }], skillExecution: { version: 1, skill: null }, skillRun: { taskId: f.task.id, user, datasetCaseId: 'dataset-case', side: 'b', runIndex: 1, executionClaimId: 'old' } }), (error: unknown) => (error as { code?: string }).code === 'EXECUTION_SUPERSEDED')
  assert.equal(await prisma.experimentTraceAttempt.count({ where: { caseId: row.id } }), 0)
})


test('A/B 与重复轮次独立呈现，默认选中正在执行的轮次', () => {
  const html = renderToStaticMarkup(createElement(SkillCaseExecutionProgress, { title: 'Case', versionLabel: 'B v2', runs: [progress({ status: 'done', stage: 4 }), progress({ runIndex: 2, roundIndex: 2 })], refreshingFailed: false, retrying: false, evaluatorName: id => id, onRefresh: () => {} }))
  assert.match(html, /B v2/)
  assert.match(html, /第 1 轮/)
  assert.match(html, /value="2" selected=""/)
  assert.match(html, /Agent 执行中/)
  const unknown = renderToStaticMarkup(createElement(SkillCaseExecutionProgress, { title: 'Case', refreshingFailed: true, retrying: false, evaluatorName: id => id, onRefresh: () => {} }))
  assert.match(unknown, /等待进度数据/)
})

test('已有 Trace 直接进入评测，失败保留原因；触发判定不等待 Trace 上传', async () => {
  const f = await fixture('use-case')
  const root = await prisma.execution.create({ data: { user, taskId: randomUUID(), agentName: 'build', timestamp: new Date() } })
  const row = await prisma.experimentCase.create({ data: { experimentId: f.experiment.id, input: 'query', taskId: root.taskId, executionId: root.id, results: { create: { experimentId: f.experiment.id, evaluatorId: 'judge', status: 'failed', errorMessage: 'judge unavailable' } } } })
  await prisma.experiment.update({ where: { id: f.experiment.id }, data: { configSnapshotJson: JSON.stringify({ traceSource: 'existing', caseIds: [row.id] }) } })
  let snapshot = await loadSkillExecutionProgress(f.experiment.id, user)
  const existing = snapshot!.progress[row.id].b![0]
  assert.equal(existing.source, 'existing')
  assert.equal(existing.stage, 3)
  assert.equal(existing.error, 'judge unavailable')
  assert.equal(existing.executionId, root.id)
  const trigger = await fixture('trigger')
  const current = { ...trigger.b, status: 'pass', sessionId: randomUUID(), executionFinishedAt: new Date().toISOString(), evaluations: [{ evaluatorId: 'judge', status: 'done', score: 100 }] }
  await commit(trigger.task.id, 'b', current)
  snapshot = await loadSkillExecutionProgress(trigger.experiment.id, user)
  assert.equal(snapshot!.progress['dataset-case'].b![0].status, 'done')
  assert.equal(snapshot!.progress['dataset-case'].b![0].executionId, null)
  assert.equal(snapshot!.progress['dataset-case'].b![0].traceId, current.sessionId)
})

test('同一执行内旧 Trace Attempt 回调不可覆盖已确认的新尝试', () => {
  const current = { ...slot(), traceAttemptId: 'attempt2', traceAttemptNo: 2, progressRevision: 10 }
  assert.equal(canWriteRunProgress(current, { ...current, traceAttemptId: 'attempt1', traceAttemptNo: 1, progressRevision: 11 }), false)
  assert.equal(canWriteRunProgress(current, { ...current, traceAttemptId: 'wrong', progressRevision: 11 }), false)
  assert.equal(canWriteRunProgress(current, { ...current, traceAttemptId: 'attempt3', traceAttemptNo: 3, progressRevision: 11 }), true)
})


test('真实重试入口覆盖触发、用例和 A/B：并发重复请求只预占一次且不改另一侧', async () => {
  const loader = Module as unknown as { _load: (id: string, ...args: unknown[]) => unknown }
  const original = loader._load
  loader._load = function (id, ...args) {
    if (id === '@opencode-ai/sdk') return { createOpencodeClient: () => assert.fail('must not call a live model') }
    return original.call(this, id, ...args)
  }
  let POST: typeof import('@/app/api/debug/grayscale-tasks/[taskId]/route')['POST']
  try { ({ POST } = loadModule('@/app/api/debug/grayscale-tasks/[taskId]/route')) }
  finally { loader._load = original }
  for (const preset of ['trigger', 'use-case', 'skill-ab']) {
    const f = await fixture(preset)
    const skill = await prisma.skill.create({ data: { user, name: randomUUID(), versions: { create: { version: 1, content: 'skill' } } }, include: { versions: true } })
    const dataset = await prisma.agentEvalDataset.create({ data: { id: randomUUID(), user, name: 'cases', casesJson: JSON.stringify([{ id: 'dataset-case', input: 'query', values: { should_trigger: true } }]) } })
    const row = await prisma.experimentCase.create({ data: { experimentId: f.experiment.id, input: 'query', actualOutput: 'old output', taskId: 'old-trace', traceGenerationError: 'old failure' } })
    const states = await read(f.task.id)
    Object.assign(states.b.runs[0], { status: 'fail', failureType: 'agent_error', failureDetail: 'old failure', experimentCaseId: row.id, sessionId: 'old-trace' })
    await prisma.grayscaleTask.update({ where: { id: f.task.id }, data: { skillId: skill.id, skillName: skill.name, skillVersionId: skill.versions[0].id,
      configJson: JSON.stringify({ skillId: skill.id, versionBId: skill.versions[0].id, versionAId: '__NONE__', linkedDatasetIds: [dataset.id], executionSides: preset === 'skill-ab' ? ['a', 'b'] : ['b'], evaluators: ['skill-trigger-analyzer'], evalExperimentId: f.experiment.id, requiresClientExecution: true, triggerRouting: preset === 'trigger' }), caseStatesJson: JSON.stringify({ 'dataset-case': states }) } })
    const request = () => POST(new NextRequest(`http://localhost/api/debug/grayscale-tasks/${f.task.id}`, { method: 'POST', body: JSON.stringify({ user, action: 'retry-run', caseId: 'dataset-case', side: 'b', runIndex: 1 }) }), { params: Promise.resolve({ taskId: f.task.id }) })
    const responses = await Promise.all([request(), request()])
    assert.deepEqual(responses.map(response => response.status).sort(), [202, 409], JSON.stringify(await Promise.all(responses.map(response => response.json()))))
    for (let wait = 0; wait < 100; wait++) {
      if ((await read(f.task.id)).b.runs[0].status === 'fail') break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const current = await read(f.task.id)
    assert.equal(current.b.runs[0].executionGeneration, 2)
    assert.notEqual(current.b.runs[0].executionClaimId, 'b')
    assert.equal(current.b.runs[0].sessionId, undefined)
    assert.equal(current.a.runs[0].executionClaimId, 'a')
    assert.equal(current.a.runs[0].status, 'running')
    assert.equal((await loadSkillExecutionProgress(f.experiment.id, user))!.progress['dataset-case'].b![0].traceId, null)
    const after = await prisma.experimentCase.findUniqueOrThrow({ where: { id: row.id } })
    assert.notEqual(after.actualOutput, 'old output')
  }
})
