import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PROTOCOL, contextDigest, preparationMessage, validateContext, type EnvironmentContext } from '../packages/benchmark-protocol/environment.cjs'

const require = createRequire(import.meta.url)
const { prepareEnvironment, loadEnvironmentAdapter } = require('../services/executor/src/environment/registry.cjs')
const { executePreparation, recoverPreparations } = require('../services/executor/src/environment/task-runner.cjs')
const { checkBuildTools } = require('../services/executor/src/xgovernor/toolchain.cjs')
const base: EnvironmentContext = { protocol: PROTOCOL, clientId: 'client-1', dataset: { id: 'dataset-1', adapterKey: 'swe-bench', revision: 'v1', caseIds: ['case-1'], faultTypes: [] }, platform: 'pi-agent', agent: 'pi-agent', model: 'provider/model', experiment: { mode: 'generate', timeoutSeconds: 600, concurrency: 1 } }

test('environment context binds dataset revision, selected Agent, model, Cases and options', () => {
  assert.deepEqual(validateContext(base), base)
  for (const changed of [
    { ...base, platform: 'xiaoo' }, { ...base, model: 'other/model' }, { ...base, agentOptions: { limit: 2 } },
    { ...base, dataset: { ...base.dataset, revision: 'v2' } }, { ...base, dataset: { ...base.dataset, caseIds: ['case-2'] } },
  ]) assert.notEqual(contextDigest(changed), contextDigest(base))
  assert.throws(() => validateContext({ ...base, shell: 'echo unsafe' }))
  assert.throws(() => validateContext({ ...base, dataset: { ...base.dataset, implementation: '/tmp/unsafe.cjs' } }))
})

test('only an actual long first-install action uses the minutes-first-install hint', () => {
  assert.equal(preparationMessage('checking', 'first_install_minutes'), '正在检查运行环境…')
  assert.equal(preparationMessage('preparing'), '正在准备运行环境…')
  assert.match(preparationMessage('preparing', 'first_install_minutes'), /首次可能需要几分钟/)
  assert.doesNotMatch(preparationMessage('preparing', 'minutes'), /首次/)
  assert.equal(preparationMessage('ready'), '')
})

test('manual prerequisites stop before installation; already-ready checks do not prepare', async () => {
  let installs = 0
  const adapter = { checkEnvironment: async () => ({ issues: [{ code: 'MODEL_CREDENTIAL_MISSING', message: '配置 API Key' }], prepare: ['sandbox'] }), prepareEnvironment: async () => { installs++ } }
  const result = await prepareEnvironment(base, {}, async () => {}, () => adapter)
  assert.equal(result.state, 'needs_action')
  assert.equal(installs, 0)
  adapter.checkEnvironment = async () => ({ issues: [], prepare: [] })
  assert.equal((await prepareEnvironment(base, {}, async () => {}, () => adapter)).state, 'ready')
  assert.equal(installs, 0)
})

test('installation is followed by a fresh check; a successful install alone never means ready', async () => {
  let checks = 0
  let installs = 0
  const states: string[] = []
  const adapter = { checkEnvironment: async () => ({ issues: [], prepare: ++checks === 1 ? ['sandbox'] : [] }), prepareEnvironment: async (_context: unknown, _services: unknown, report: (value: unknown) => Promise<void>) => { installs++; await report({ state: 'preparing', durationHint: 'first_install_minutes' }) } }
  const result = await prepareEnvironment(base, {}, async (value: { state: string }) => { states.push(value.state) }, () => adapter)
  assert.equal(result.state, 'ready')
  assert.equal(checks, 2)
  assert.equal(installs, 1)
  assert.deepEqual(states, ['checking', 'preparing', 'preparing', 'checking'])
  adapter.checkEnvironment = async () => ({ issues: [], prepare: ['sandbox'] })
  await assert.rejects(() => prepareEnvironment(base, {}, async () => {}, () => adapter), /准备后仍有运行组件未就绪/)
})

test('dataset adapters own Agent differences and unknown adapters cannot silently use generic checks', async () => {
  const calls: string[] = []
  const services = {
    executionBinding: (context: EnvironmentContext) => context.platform === 'pi-agent' ? { backendKey: 'xgovernor' } : null,
    checkSandbox: async () => { calls.push('sandbox'); return { issues: [], prepare: ['sandbox'] } },
    checkMcts: async () => { calls.push('mcts'); return { issues: [], prepare: [] } },
    checkAgent: async () => { calls.push('generic'); return [] },
    checkFaultInjection: async () => { calls.push('fi'); return { issues: [], prepare: ['fault-injection'] } },
  }
  const swe = loadEnvironmentAdapter('swe-bench')
  await swe.checkEnvironment(base, services)
  await swe.checkEnvironment({ ...base, platform: 'pi-mcts' }, services)
  await swe.checkEnvironment({ ...base, platform: 'opencode' }, services)
  await loadEnvironmentAdapter('reliability').checkEnvironment({ ...base, platform: 'opencode' }, services)
  assert.deepEqual(calls, ['sandbox', 'mcts', 'generic', 'generic', 'fi'])
  assert.throws(() => loadEnvironmentAdapter('not-installed'), /客户端未包含/)
})

test('checking build prerequisites never invokes a package manager', async () => {
  const commands: string[] = []
  const missing = await checkBuildTools({ root: '/tmp/fixture', command: async (file: string) => { commands.push(file); if (file === 'cc') throw new Error('missing'); return '' } })
  assert.deepEqual(missing, ['cc'])
  assert(!commands.some(file => ['sudo', 'apt-get', 'dnf', 'yum'].includes(file)))
})

test('concurrent same-context tasks share one preparation and manual retry performs a new check', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'environment-task-'))
  const frame = (id: string) => ({ commandId: id, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10000).toISOString(), payload: { context: base, contextDigest: contextDigest(base) } })
  let runs = 0
  const worker = async () => { runs++; await new Promise(resolve => setTimeout(resolve, 50)); return { state: 'ready', issues: [] } }
  const options = { cfg: { clientId: base.clientId }, baseDir: root, report: async () => {}, worker }
  try {
    const [a, b] = await Promise.all([executePreparation(frame('one'), options), executePreparation(frame('two'), options)])
    assert.equal(a.state, 'ready'); assert.equal(b.state, 'ready'); assert.equal(runs, 1)
    await executePreparation(frame('three'), options)
    assert.equal(runs, 2)
    await assert.rejects(() => executePreparation({ ...frame('four'), payload: { context: base, contextDigest: 'sha256:bad' } }, options), /不匹配/)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('real worker returns manual-action results and recovery replays facts without another install', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'environment-worker-'))
  const previous = process.env.AGENT_INSIGHT_HOME
  process.env.AGENT_INSIGHT_HOME = root
  const context = { ...base, dataset: { ...base.dataset, adapterKey: 'generic' }, platform: 'fixture-agent-not-installed', agent: 'fixture' }
  const stages: string[] = []
  const frame = { commandId: 'worker-test', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 15000).toISOString(), payload: { context, contextDigest: contextDigest(context) } }
  try {
    const result = await executePreparation(frame, { cfg: { clientId: context.clientId }, baseDir: root, report: async (progress: { state: string }) => { stages.push(progress.state) } })
    assert.equal(result.state, 'needs_action')
    assert.equal(result.issues[0].code, 'AGENT_NOT_INSTALLED')
    assert(stages.includes('checking'))
    const recovered: Array<{ id: string; state: string }> = []
    await recoverPreparations(root, async (id: string, report: { state: string }) => { recovered.push({ id, state: report.state }) })
    assert.deepEqual(recovered, [{ id: 'worker-test', state: 'needs_action' }])
    await recoverPreparations(root, async () => { assert.fail('already-reported task replayed') })
    const record = path.join(root, 'environment-preparations', `${'a'.repeat(64)}.json`)
    await fs.writeFile(record, JSON.stringify({ taskId: 'interrupted', expiresAt: frame.expiresAt }))
    await recoverPreparations(root, async (id: string, report: { state: string }) => { assert.equal(id, 'interrupted'); assert.equal(report.state, 'failed') })
  } finally {
    if (previous === undefined) delete process.env.AGENT_INSIGHT_HOME; else process.env.AGENT_INSIGHT_HOME = previous
    await fs.rm(root, { recursive: true, force: true })
  }
})
