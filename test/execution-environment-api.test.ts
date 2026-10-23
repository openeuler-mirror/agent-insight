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
