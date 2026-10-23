import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mergeCapabilities, updateCapabilities, type ClientCapabilities } from '../src/lib/reliability/client-registry'
import { mergeWorkerInventory, upsertWorkerHeartbeat } from '../src/lib/fault-injection/worker-protocol'
import { prisma } from '../src/lib/storage/prisma'

const require = createRequire(import.meta.url)
const { normalizeExecutionConfig, describeProfile } = require('../packages/benchmark-protocol/execution.cjs')
const { createServices } = require('../services/executor/src/environment/services.cjs')
const context = { platform: 'opencode', agent: 'build', model: 'provider/model', dataset: { adapterKey: 'reliability', faultTypes: ['fixture-fault'] } }

test('selected capability updates preserve other Agents, models, FI state and unrelated components', () => {
  const current: ClientCapabilities = {
    platforms: [{ id: 'opencode', agents: ['build', 'review'], models: ['provider/other'], actions: ['RUN_EXPERIMENT_CASE'] }, { id: 'xiaoo', agents: ['defaultagent'], models: ['other/model'] }],
    actions: ['PREPARE_EXECUTION_ENVIRONMENT'], components: { unrelated: { ready: true } }, faultInjection: { ready: true },
  }
  const updated = mergeCapabilities(current, { platforms: [{ id: 'opencode', agents: ['build'], models: ['provider/model'], runExperimentCase: { version: 2, returnsTraceId: true } }], components: { 'agent-runtime/opencode/v1': { ready: true } } })
  assert.deepEqual(updated.platforms[1], { ...current.platforms[1], version: undefined, runExperimentCase: undefined, runBenchmarkCase: undefined, parameterDefinitions: [], actions: undefined })
  assert.deepEqual(updated.platforms[0].agents, ['build', 'review'])
  assert.deepEqual(updated.platforms[0].models, ['provider/other', 'provider/model'])
  assert.deepEqual(updated.platforms[0].actions, ['RUN_EXPERIMENT_CASE'])
  assert.deepEqual(updated.faultInjection?.ready, true)
  assert.deepEqual(updated.components?.unrelated, { ready: true })
})

test('installed Profile updates freeze its final identity without claiming unchecked Runtimes are ready', () => {
  const config = normalizeExecutionConfig().profiles['xgovernor-local-docker']
  const profile = describeProfile('xgovernor-local-docker', config)
  const current: ClientCapabilities = { platforms: [], executionProfiles: [{ profile, benchmarks: ['swe-bench'], ready: true, targetReadiness: { 'pi-agent': { ready: true }, xiaoo: { ready: true } } }] }
  const patch = { profile, benchmarks: ['swe-bench'], ready: true, targetReadiness: { 'pi-agent': { ready: true } } }
  assert.equal(mergeCapabilities(current, { platforms: [], executionProfiles: [patch] }).executionProfiles?.[0].targetReadiness?.xiaoo.ready, true)
  const installed = describeProfile(profile.key, { ...config, serverExecutable: '/fixture/installed-server', artifactDigest: `sha256:${'a'.repeat(64)}` })
  const updated = mergeCapabilities(current, { platforms: [], executionProfiles: [{ ...patch, profile: installed }] }).executionProfiles![0]
  assert.equal(updated.profile.definitionDigest, installed.definitionDigest)
  assert.equal(updated.targetReadiness?.['pi-agent'].ready, true)
  assert.equal(updated.targetReadiness?.xiaoo.ready, false)
  assert.equal(updated.ready, false)
})

test('selected FI inventory merges preserve the unselected platform and existing catalog entries', () => {
  const other = { ready: true, agents: [{ id: 'defaultagent' }], models: [{ id: 'other/model' }] }
  const updated = mergeWorkerInventory(JSON.stringify({ platforms: { xiaoo: other, opencode: { ready: false, agents: [{ id: 'review' }], models: [{ id: 'provider/other' }] } }, reportedIp: '192.0.2.1' }),
    { platforms: { opencode: { ready: true, agents: [{ id: 'build' }], models: [{ id: 'provider/model' }] } } })
  assert.deepEqual(updated.platforms.xiaoo, other)
  const selected = updated.platforms.opencode as { ready: boolean; agents: Array<{ id: string }>; models: Array<{ id: string }> }
  assert.equal(selected.ready, true)
  assert.deepEqual(selected.agents.map(item => item.id), ['review', 'build'])
  assert.deepEqual(selected.models.map(item => item.id), ['provider/other', 'provider/model'])
  assert.equal(updated.reportedIp, '192.0.2.1')
})

test('partial capability reports retry concurrent writes and keep the newly reported peer platform', async () => {
  const store = prisma.reliabilityClient as unknown as {
    findUnique: () => Promise<{ capabilitiesJson: string; capabilitiesRevision: string }>
    updateMany: (input: { data: { capabilitiesJson: string; capabilitiesRevision: string } }) => Promise<{ count: number }>
  }
  const original = { findUnique: store.findUnique, updateMany: store.updateMany }
  let row = { capabilitiesJson: JSON.stringify({ platforms: [{ id: 'xiaoo', agents: ['first'] }] }), capabilitiesRevision: 'initial' }
  let attempts = 0
  store.findUnique = async () => row
  store.updateMany = async ({ data }) => {
    if (++attempts === 1) {
      row = { capabilitiesJson: JSON.stringify({ platforms: [{ id: 'xiaoo', agents: ['first', 'concurrent'] }] }), capabilitiesRevision: 'concurrent' }
      return { count: 0 }
    }
    row = data
    return { count: 1 }
  }
  try {
    await updateCapabilities({ clientId: 'fixture', revision: 'selected', partial: true, capabilities: { platforms: [{ id: 'opencode', agents: ['build'] }] } })
    assert.equal(attempts, 2)
    assert.deepEqual(JSON.parse(row.capabilitiesJson).platforms.find((item: { id: string }) => item.id === 'xiaoo').agents, ['first', 'concurrent'])
    assert.equal(row.capabilitiesRevision, 'selected')
  } finally { Object.assign(store, original) }
})

test('partial FI heartbeat creates its Worker and retries a concurrent inventory update without losing it', async () => {
  type Row = { inventoryJson: string }
  const store = prisma.faultInjectionWorker as unknown as {
    findUnique: () => Promise<Row | null>
    findUniqueOrThrow: () => Promise<Row>
    upsert: (input: { create: Row }) => Promise<Row>
    updateMany: (input: { data: Row }) => Promise<{ count: number }>
  }
  const original = { findUnique: store.findUnique, findUniqueOrThrow: store.findUniqueOrThrow, upsert: store.upsert, updateMany: store.updateMany }
  let row: Row | null = null
  let attempts = 0
  store.findUnique = async () => row
  store.findUniqueOrThrow = async () => row!
  store.upsert = async ({ create }) => { row ||= create; return row }
  store.updateMany = async ({ data }) => {
    if (++attempts === 1) {
      row = { inventoryJson: JSON.stringify({ platforms: { xiaoo: { ready: true, agents: ['peer'] } } }) }
      return { count: 0 }
    }
    row = data
    return { count: 1 }
  }
  try {
    const result = await upsertWorkerHeartbeat({ user: 'fixture', workerId: 'fixture', partial: true, inventory: { platforms: { opencode: { ready: true, agents: ['build'] } } } })
    assert.equal(attempts, 2)
    const inventory = JSON.parse(result.inventoryJson)
    assert.deepEqual(inventory.platforms.xiaoo.agents, ['peer'])
    assert.deepEqual(inventory.platforms.opencode.agents, ['build'])
  } finally { Object.assign(store, original) }
})

test('reliability checks inspect only the selected FI adapter and required fault definitions', async () => {
  const calls: string[][] = []
  const services = createServices({ cfg: { fiPython: '/fixture/python' }, env: {}, client: {
    resolveFiCwd: () => '/fixture/package',
    probeFaultInjection: () => assert.fail('full inventory must not run'),
  }, command: async (_file: string, args: string[]) => {
    calls.push(args)
    return args.at(-1) === 'opencode' ? JSON.stringify({ ready: true, agents: [{ id: 'build' }] }) : '[]'
  } })
  assert.deepEqual(await services.checkFaultInjection(context), { issues: [], prepare: [] })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].at(-1), 'opencode')
  assert.doesNotMatch(calls[0][2], /list_models|build_platform_inventory/)
  assert.equal(calls[1].at(-1), '["fixture-fault"]')
  assert.deepEqual(Object.keys(services.capabilityUpdate().fiInventory.platforms), ['opencode'])
})

test('ordinary checks reject empty OpenCode credentials instead of accepting an existing auth entry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-auth-'))
  const oldPath = process.env.PATH
  const oldHome = process.env.AGENT_INSIGHT_HOME
  try {
    process.env.PATH = root
    process.env.AGENT_INSIGHT_HOME = root
    fs.writeFileSync(path.join(root, 'opencode'), '#!/bin/sh\n', { mode: 0o755 })
    fs.mkdirSync(path.join(root, 'opencode-data/opencode'), { recursive: true })
    fs.writeFileSync(path.join(root, 'opencode-data/opencode/auth.json'), JSON.stringify({ provider: { type: 'api', key: '   ' } }))
    const services = createServices({ cfg: {}, env: { HOME: root, XDG_DATA_HOME: path.join(root, 'opencode-data'), PROVIDER_API_KEY: '   ' }, client: { probeExperimentRuntime: () => ({ ready: true, canResolveTraceId: true }) }, command: async () => JSON.stringify({ model: 'provider/model' }) })
    const issues = await services.checkAgent(context)
    assert(issues.some((item: { code: string }) => item.code === 'MODEL_CREDENTIAL_MISSING'))
    fs.writeFileSync(path.join(root, 'opencode-data/opencode/auth.json'), JSON.stringify({ provider: { type: 'oauth', refresh: 'fixture-refresh' } }))
    assert.deepEqual(await services.checkAgent(context), [])
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    if (oldHome === undefined) delete process.env.AGENT_INSIGHT_HOME; else process.env.AGENT_INSIGHT_HOME = oldHome
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('normal preparation and restart recovery complete without full discovery or unrelated processes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'environment-capabilities-'))
  const previousHome = process.env.AGENT_INSIGHT_HOME
  const daemonPath = require.resolve('../scripts/reliability-client.cjs')
  const previousModule = require.cache[daemonPath]
  const taskRunner = require('../services/executor/src/environment/task-runner.cjs')
  const childProcess = require('node:child_process')
  const previousSpawn = childProcess.spawn
  const previousSpawnSync = childProcess.spawnSync
  const previousExecute = taskRunner.executePreparation
  const previousMark = taskRunner.markPreparationReported
  const previousFetch = globalThis.fetch
  const reports: Array<{ url: string; body: Record<string, unknown> }> = []
  let marked = 0
  const result = { state: 'ready', issues: [], capabilities: { platforms: [{ id: 'opencode', agents: ['build'] }], components: { 'agent-runtime/opencode/v1': { ready: true } } } }
  try {
    process.env.AGENT_INSIGHT_HOME = root
    fs.mkdirSync(path.join(root, 'client'), { recursive: true })
    fs.writeFileSync(path.join(root, 'client/config.json'), JSON.stringify({ insightBaseUrl: 'https://fixture.invalid', clientId: 'fixture', deviceCredential: 'fixture' }))
    childProcess.spawn = childProcess.spawnSync = () => assert.fail('normal check must not spawn a full capability probe')
    taskRunner.executePreparation = async () => result
    taskRunner.markPreparationReported = async () => { marked++ }
    globalThis.fetch = async (url, options) => {
      reports.push({ url: String(url), body: JSON.parse(String(options?.body)) })
      return new Response('{}', { status: 200 })
    }
    delete require.cache[daemonPath]
    const daemon = require(daemonPath)
    const statuses: string[] = []
    await daemon.executeAction({}, { commandId: 'normal', action: 'PREPARE_EXECUTION_ENVIRONMENT', payload: {} }, async (status: string) => { statuses.push(status) })
    assert.deepEqual(statuses, ['RUNNING', 'SUCCEEDED'])
    assert.equal(reports.length, 1)
    assert.equal(reports[0].body.partial, true)
    assert(!reports.some(item => item.url.includes('heartbeat')))

    taskRunner.executePreparation = async () => ({ state: 'needs_action', issues: [{ code: 'MODEL_CREDENTIAL_MISSING', message: '配置 API Key' }] })
    const manual: Array<{ status: string; state?: string }> = []
    await daemon.executeAction({}, { commandId: 'manual', action: 'PREPARE_EXECUTION_ENVIRONMENT', payload: {} }, async (status: string, extra: { result?: { state: string } }) => { manual.push({ status, state: extra.result?.state }) })
    assert.equal(manual.at(-1)?.state, 'needs_action')
    assert.equal(reports.length, 1)
    taskRunner.executePreparation = async () => result

    const workingFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('{}', { status: 503 })
    const failed: string[] = []
    await daemon.executeAction({}, { commandId: 'report-failed', action: 'PREPARE_EXECUTION_ENVIRONMENT', payload: {} }, async (status: string) => { failed.push(status) })
    assert.deepEqual(failed, ['RUNNING'])
    globalThis.fetch = workingFetch

    const beforeTerminal = marked
    globalThis.fetch = async (url, options) => String(url).endsWith('/unconfirmed/status') ? new Response('{}', { status: 503 }) : workingFetch(url, options)
    const wss: string[] = []
    await daemon.handleCommand(daemon.loadConfig(), { commandId: 'unconfirmed', action: 'PREPARE_EXECUTION_ENVIRONMENT', payload: {} }, async (_id: string, status: string) => { wss.push(status) })
    assert.deepEqual(wss, ['RECEIVED', 'RUNNING'])
    assert.equal(marked, beforeTerminal)
    const spoolFile = path.join(root, 'client/spool.json')
    const spool = fs.existsSync(spoolFile) ? JSON.parse(fs.readFileSync(spoolFile, 'utf8')) : []
    assert(!spool.some((item: { commandId: string; body: { status: string } }) => item.commandId === 'unconfirmed' && item.body.status === 'SUCCEEDED'))
    globalThis.fetch = workingFetch

    const records = path.join(root, 'client/environment-preparations')
    fs.mkdirSync(records, { recursive: true })
    fs.writeFileSync(path.join(records, `${'a'.repeat(64)}.json`), JSON.stringify({ taskId: 'recovered', context: {}, contextDigest: `sha256:${'a'.repeat(64)}`, expiresAt: new Date(Date.now() + 60000).toISOString(), result }))
    await daemon.recoverEnvironmentTasks(daemon.loadConfig())
    assert(reports.filter(item => item.body.partial === true).length >= 2)
    assert(reports.some(item => item.url.endsWith('/recovered/status') && item.body.status === 'SUCCEEDED'))

    await daemon.reportEnvironmentCapabilities(daemon.loadConfig(), { ...result, fiInventory: { platforms: { opencode: { ready: true, agents: [{ id: 'build' }], models: [] } } } })
    const fi = reports.at(-1)!
    assert(fi.url.endsWith('/worker/heartbeat'))
    assert.equal(fi.body.partial, true)
  } finally {
    taskRunner.executePreparation = previousExecute
    taskRunner.markPreparationReported = previousMark
    childProcess.spawn = previousSpawn
    childProcess.spawnSync = previousSpawnSync
    globalThis.fetch = previousFetch
    if (previousModule) require.cache[daemonPath] = previousModule; else delete require.cache[daemonPath]
    if (previousHome === undefined) delete process.env.AGENT_INSIGHT_HOME; else process.env.AGENT_INSIGHT_HOME = previousHome
    fs.rmSync(root, { recursive: true, force: true })
  }
})
