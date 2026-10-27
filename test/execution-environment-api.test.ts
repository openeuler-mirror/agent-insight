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
import { createRequire } from 'node:module'
import { createIsolatedDatabase } from './helpers/isolated-database'

const require = createRequire(import.meta.url)
const database = createIsolatedDatabase()
const { prismaRaw: store } = require('../src/lib/storage/prisma') as typeof import('@/lib/storage/prisma')
const { createInstallToken, registerClient } = require('../src/lib/reliability/client-registry') as typeof import('@/lib/reliability/client-registry')
const { createEnvironmentPreparation, getEnvironmentPreparation } = require('../src/lib/engine/experiment/environment-preparation') as typeof import('@/lib/engine/experiment/environment-preparation')
const { applyCommandStatus, assertPayloadSafe } = require('../src/lib/reliability/command-bus') as typeof import('@/lib/reliability/command-bus')
const { ACTION, PROTOCOL, contextDigest } = require('../packages/benchmark-protocol/environment.cjs')

test.after(async () => { await store.$disconnect(); database.dispose() })
const user = 'environment-api-test'
const dispatch = async () => ({ delivered: false, connected: false })
let sequence = 0

async function fixture(kind = 'ideal_output', preparation = true) {
  const id = `environment-dataset-${++sequence}`
  const { installToken } = await createInstallToken({ user })
  const client = await registerClient({ installToken, hostname: 'environment-host', capabilities: {
    actions: preparation ? [ACTION, 'RUN_EXPERIMENT_CASE'] : ['RUN_EXPERIMENT_CASE'],
    platforms: [{ id: 'opencode', agents: ['build'], runExperimentCase: { version: 2, returnsTraceId: true } }],
  } })
  await store.reliabilityClient.update({ where: { clientId: client.clientId }, data: { serviceHealth: 'healthy' } })
  await store.agentEvalDataset.create({ data: { id, user, name: 'fixture', datasetKind: kind, casesJson: JSON.stringify([{ id: 'case-1', input: 'task', values: { fault_injection_type: 'tool-repetition' } }]) } })
  return { requestId: `request-${sequence}-0000`, datasetId: id, clientId: client.clientId, platform: 'opencode', agent: 'build', model: '', caseIds: ['case-1'], mode: 'generate', timeoutSeconds: 600, concurrency: 1 }
}

test('ordinary and reliability datasets resolve their own executor entry and keep private data out', async () => {
  for (const [kind, adapter] of [['ideal_output', 'generic'], ['reliability', 'reliability']]) {
    const input = await fixture(kind)
    const task = await createEnvironmentPreparation(user, input, store, dispatch)
    const row = await store.reliabilityCommand.findUniqueOrThrow({ where: { commandId: task.taskId } })
    const payload = JSON.parse(row.payloadJson)
    assert.equal(payload.context.dataset.adapterKey, adapter)
    assert.equal(payload.context.protocol, PROTOCOL)
    assert.equal(payload.context.dataset.faultTypes[0], 'tool-repetition')
    assert.equal(payload.contextDigest, contextDigest(payload.context))
    assertPayloadSafe(ACTION, payload)
    assert(!('casesJson' in payload.context.dataset))
    assert(row.expiresAt.getTime() - row.createdAt.getTime() > 40 * 60 * 1000)
    assert.equal(task.state, 'checking')
  }
})

test('retries share one task, active same-context tasks are reused, changed context cannot reuse request id', async () => {
  const input = await fixture()
  const first = await createEnvironmentPreparation(user, input, store, dispatch)
  const repeated = await createEnvironmentPreparation(user, input, store, dispatch)
  const secondTab = await createEnvironmentPreparation(user, { ...input, requestId: 'other-tab-0000' }, store, dispatch)
  assert.equal(repeated.taskId, first.taskId)
  assert.equal(secondTab.taskId, first.taskId)
  await assert.rejects(() => createEnvironmentPreparation(user, { ...input, model: 'other/model' }, store, dispatch), /配置已变化/)
})

test('completed manual-action result is not ready and a new click rechecks after user configuration', async () => {
  const input = await fixture()
  const first = await createEnvironmentPreparation(user, input, store, dispatch)
  await applyCommandStatus({ clientId: input.clientId, commandId: first.taskId, status: 'SUCCEEDED', result: { state: 'needs_action', issues: [{ code: 'MODEL_CREDENTIAL_MISSING', message: '请在执行机配置 API Key' }] } })
  const result = await getEnvironmentPreparation(user, first.taskId, store)
  assert.equal(result.state, 'needs_action')
  assert.match(result.message, /API Key/)
  const retry = await createEnvironmentPreparation(user, { ...input, requestId: 'fixed-key-0000' }, store, dispatch)
  assert.notEqual(retry.taskId, first.taskId)
  await applyCommandStatus({ clientId: input.clientId, commandId: retry.taskId, status: 'SUCCEEDED', result: { state: 'ready', issues: [] } })
  assert.equal((await getEnvironmentPreparation(user, retry.taskId, store)).state, 'ready')
})

test('ownership, current Case membership, old clients and unbound clients remain enforced', async () => {
  const input = await fixture()
  await assert.rejects(() => createEnvironmentPreparation('another-user', input, store, dispatch), /无权访问/)
  await assert.rejects(() => createEnvironmentPreparation(user, { ...input, caseIds: ['missing'] }, store, dispatch), /Case 已变化/)
  await assert.rejects(() => createEnvironmentPreparation(user, { ...input, shell: 'unsafe' }, store, dispatch), /检查数据集/)
  const task = await createEnvironmentPreparation(user, input, store, dispatch)
  await assert.rejects(() => getEnvironmentPreparation('another-user', task.taskId, store), /无权访问/)
  await store.reliabilityClient.update({ where: { clientId: input.clientId }, data: { unboundAt: new Date() } })
  await assert.rejects(() => getEnvironmentPreparation(user, task.taskId, store), /无权访问/)
  const old = await fixture('ideal_output', false)
  await assert.rejects(() => createEnvironmentPreparation(user, old, store, dispatch), /更新客户端/)
})

test('protocol checks reject executable injection and report task timeout without claiming readiness', async () => {
  const input = await fixture()
  const task = await createEnvironmentPreparation(user, input, store, dispatch)
  const row = await store.reliabilityCommand.findUniqueOrThrow({ where: { commandId: task.taskId } })
  const payload = JSON.parse(row.payloadJson)
  assert.throws(() => assertPayloadSafe(ACTION, { ...payload, shell: 'unsafe' }))
  assert.throws(() => assertPayloadSafe(ACTION, { ...payload, context: { ...payload.context, path: '/tmp' } }))
  await store.reliabilityCommand.update({ where: { commandId: task.taskId }, data: { expiresAt: new Date(0) } })
  assert.equal((await getEnvironmentPreparation(user, task.taskId, store)).state, 'failed')
})

test('legacy multiline dataset Cases without ids remain selectable for environment checks', async () => {
  const input = await fixture()
  const multiline = 'task line 1\ntask line 2'
  await store.agentEvalDataset.update({ where: { id: input.datasetId }, data: { casesJson: JSON.stringify([{ input: multiline }]) } })
  const task = await createEnvironmentPreparation(user, { ...input, caseIds: [`dataset-case-0:${multiline}`] }, store, dispatch)
  assert.equal(task.state, 'checking')
})

test('preparation ACK keeps its short deadline and a retry does not reuse an unacknowledged task', async () => {
  const input = await fixture()
  const first = await createEnvironmentPreparation(user, input, store, dispatch)
  await store.reliabilityCommand.update({ where: { commandId: first.taskId }, data: { status: 'SENT', sentAt: new Date(Date.now() - 60000) } })
  const failed = await getEnvironmentPreparation(user, first.taskId, store)
  assert.equal(failed.state, 'failed')
  assert.match(failed.message, /未确认收到/)
  const retry = await createEnvironmentPreparation(user, { ...input, requestId: 'ack-retry-0000' }, store, dispatch)
  assert.notEqual(retry.taskId, first.taskId)
})

test('ready results become invalid when dataset contents or host health change', async () => {
  const input = await fixture()
  const first = await createEnvironmentPreparation(user, input, store, dispatch)
  await applyCommandStatus({ clientId: input.clientId, commandId: first.taskId, status: 'SUCCEEDED', result: { state: 'ready', issues: [] } })
  await store.agentEvalDataset.update({ where: { id: input.datasetId }, data: { casesJson: JSON.stringify([{ id: 'case-1', input: 'changed' }]) } })
  assert.match((await getEnvironmentPreparation(user, first.taskId, store)).message, /数据集内容/)
  await store.reliabilityClient.update({ where: { clientId: input.clientId }, data: { serviceHealth: 'degraded' } })
  await assert.rejects(() => createEnvironmentPreparation(user, { ...input, requestId: 'health-retry-0000' }, store, dispatch), /服务尚未就绪/)
})

test('late progress and ACK cannot overwrite a concurrent ready result or move the command backwards', async () => {
  for (const [lateStatus, finalStatus] of [['RUNNING', 'SUCCEEDED'], ['RECEIVED', 'RUNNING']] as const) {
    const input = await fixture()
    const task = await createEnvironmentPreparation(user, input, store, dispatch)
    const delegate = store.reliabilityCommand as unknown as { findUnique: (args: unknown) => Promise<unknown> }
    const original = delegate.findUnique
    let release!: () => void
    let read!: () => void
    const released = new Promise<void>(resolve => { release = resolve })
    const snapshotRead = new Promise<void>(resolve => { read = resolve })
    let held = false
    delegate.findUnique = async args => {
      const snapshot = await original(args)
      if (!held) { held = true; read(); await released }
      return snapshot
    }
    try {
      const late = applyCommandStatus({ clientId: input.clientId, commandId: task.taskId, status: lateStatus, result: { state: 'checking' } })
      await snapshotRead
      await applyCommandStatus({ clientId: input.clientId, commandId: task.taskId, status: finalStatus, result: { state: finalStatus === 'SUCCEEDED' ? 'ready' : 'preparing', issues: [] } })
      release()
      await late
      const row = await store.reliabilityCommand.findUniqueOrThrow({ where: { commandId: task.taskId } })
      assert.equal(row.status, finalStatus)
      assert.equal(JSON.parse(row.resultJson!).state, finalStatus === 'SUCCEEDED' ? 'ready' : 'preparing')
    } finally { release(); delegate.findUnique = original }
  }
})

const { createReuseEnvironmentPreparation } = require('../src/lib/engine/experiment/environment-preparation') as typeof import('@/lib/engine/experiment/environment-preparation')
const { resolveReuseEnvironment } = require('../src/lib/engine/experiment/reuse-environment') as typeof import('@/lib/engine/experiment/reuse-environment')

async function reuseFixture(kind = 'ideal_output') {
  const input = await fixture(kind)
  const snapshot = { datasetId: input.datasetId, traceSource: 'generate', executionConcurrency: 2, fiOrchestrate: kind === 'reliability',
    executionTarget: { workerId: input.clientId, platform: input.platform, agent: input.agent, model: 'provider/model', timeoutSeconds: 300 } }
  const source = await store.experiment.create({ data: { user, name: 'reuse', agentName: 'build', configSnapshotJson: JSON.stringify(snapshot),
    cases: { create: [{ input: 'task', faultInjectionType: kind === 'reliability' ? 'tool-repetition' : null, caseValuesJson: JSON.stringify({ __agentInsightDatasetCase: { datasetId: input.datasetId, caseId: 'case-1' } }) }] } } })
  return { input, snapshot, source, request: { sourceExperimentId: source.id, requestId: input.requestId } }
}

test('same-config prepares only the frozen host, Agent, model and active dataset Cases', async () => {
  for (const kind of ['ideal_output', 'reliability']) {
    const { input, source, request } = await reuseFixture(kind)
    await store.experimentCase.create({ data: { experimentId: source.id, input: 'removed', deletedAt: new Date() } })
    const before = await store.experiment.count()
    const task = await createReuseEnvironmentPreparation(user, request, store, dispatch)
    assert('taskId' in task)
    const row = await store.reliabilityCommand.findUniqueOrThrow({ where: { commandId: task.taskId } })
    const { context } = JSON.parse(row.payloadJson)
    assert.equal(context.clientId, input.clientId)
    assert.equal(context.platform, input.platform)
    assert.equal(context.agent, 'build')
    assert.equal(context.model, 'provider/model')
    assert.deepEqual(context.dataset.caseIds, ['case-1'])
    assert.equal(context.dataset.adapterKey, kind === 'reliability' ? 'reliability' : 'generic')
    assert.deepEqual(context.experiment, { mode: 'generate', timeoutSeconds: 300, concurrency: 2 })
    assert.equal(await store.experiment.count(), before)
  }
})

test('same-config skips existing Trace evaluation but checks Skill A/B even with existing Traces', async () => {
  const { source, snapshot, request } = await reuseFixture()
  await store.experiment.update({ where: { id: source.id }, data: { configSnapshotJson: JSON.stringify({ ...snapshot, traceSource: 'existing', executionTarget: null }) } })
  assert.deepEqual(await createReuseEnvironmentPreparation(user, request, store, dispatch), { state: 'skipped' })
  for (const preset of ['skill-ab', 'trigger']) {
    await store.experiment.update({ where: { id: source.id }, data: { scope: 'skill-workbench', preset,
      configSnapshotJson: JSON.stringify({ ...snapshot, traceSource: 'existing', grayscaleTaskId: 'frozen-task', caseIds: ['case-1'], runtime: { timeoutMs: 240000 } }) } })
    const selection = await resolveReuseEnvironment(user, source.id, store)
    assert.equal(selection?.mode, preset)
    assert.equal(selection?.timeoutSeconds, 240)
    assert.equal(selection?.concurrency, 1)
    assert.deepEqual(selection?.caseIds, ['case-1'])
  }
})

test('same-config rejects foreign/deleted sources, injected targets and incomplete legacy config', async () => {
  const { source, request } = await reuseFixture()
  await assert.rejects(() => createReuseEnvironmentPreparation('other', request, store, dispatch), /无权访问/)
  await assert.rejects(() => createReuseEnvironmentPreparation(user, { ...request, clientId: 'different-host' }, store, dispatch), /请求无效/)
  await store.experimentCase.updateMany({ where: { experimentId: source.id }, data: { caseValuesJson: null } })
  await assert.rejects(() => createReuseEnvironmentPreparation(user, request, store, dispatch), /复用评测配置/)
  await store.experiment.update({ where: { id: source.id }, data: { deletedAt: new Date() } })
  await assert.rejects(() => createReuseEnvironmentPreparation(user, request, store, dispatch), /无权访问/)
})

test('Benchmark same-config restores Pi/xiaoO options and checks preparation before runtime readiness', async () => {
  for (const platform of ['pi-agent', 'xiaoo']) {
    const { input, source, request } = await reuseFixture('benchmark')
    await store.reliabilityClient.update({ where: { clientId: input.clientId }, data: { capabilitiesJson: JSON.stringify({ actions: [ACTION], platforms: [{ id: platform, agents: [platform] }] }) } })
    const dataset = await store.benchmarkDataset.create({ data: { user, name: source.id, agentEvalDatasetId: input.datasetId, adapterKey: 'swe-bench', contentHash: 'content',
      cases: { create: { id: `benchmark-case-${platform}`, externalCaseId: 'case-1', rawCaseJson: '{}', publicPayloadJson: '{}', privatePayloadJson: '{}', sourceFingerprint: 's', publicFingerprint: 'p', privateFingerprint: 'v', ordinal: 0 } } } })
    const caseId = `benchmark-case-${platform}`
    await store.agentEvalDataset.update({ where: { id: input.datasetId }, data: { casesJson: JSON.stringify([{ id: caseId, input: 'task' }]) } })
    const agentOptions = { version: 2, runtimeKey: platform, definitionDigest: `sha256:${'a'.repeat(64)}`, values: { active_profile: 'test-profile' } }
    await store.experiment.update({ where: { id: source.id }, data: { scope: 'benchmark', configSnapshotJson: JSON.stringify({ clientId: input.clientId }),
      benchmarkBinding: { create: { datasetId: dataset.id, adapterKey: 'swe-bench', datasetContentHash: 'content', expectedCaseCount: 1, selectionJson: JSON.stringify({ mode: 'explicit', caseIds: [caseId] }),
        runConfigJson: JSON.stringify({ platform, agent: platform, model: 'provider/model', timeoutSeconds: 900, executionConcurrency: 3, agentOptions }) } } } })
    const task = await createReuseEnvironmentPreparation(user, request, store, dispatch)
    assert('taskId' in task)
    const row = await store.reliabilityCommand.findUniqueOrThrow({ where: { commandId: task.taskId } })
    const { context } = JSON.parse(row.payloadJson)
    assert.equal(context.platform, platform)
    assert.equal(context.dataset.adapterKey, 'swe-bench')
    assert.deepEqual(context.dataset.caseIds, [caseId])
    assert.deepEqual(context.agentOptions, agentOptions)
    await store.benchmarkExperimentBinding.update({ where: { experimentId: source.id }, data: { selectionJson: '{"mode":"all"}' } })
    assert.deepEqual((await resolveReuseEnvironment(user, source.id, store))?.caseIds, [caseId])
  }
})


test('same-config refuses changed reliability requirements instead of checking a different fault', async () => {
  const { input, request } = await reuseFixture('reliability')
  await store.agentEvalDataset.update({ where: { id: input.datasetId }, data: { casesJson: JSON.stringify([{ id: 'case-1', input: 'task', values: { fault_injection_type: 'other-fault' } }]) } })
  await assert.rejects(() => createReuseEnvironmentPreparation(user, request, store, dispatch), /复用评测配置/)
})
