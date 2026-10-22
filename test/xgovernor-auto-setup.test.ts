import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { installSelectedBackend, readSetup, COMPATIBLE_REVISION } = require('../services/executor/src/xgovernor/setup.cjs')
const { resolveNative, resolveModel, resolvePi, resolveXiaoo } = require('../services/executor/src/xgovernor/model-resolver.cjs')
const { traceApiKey } = require('../services/executor/src/xgovernor/credentials.cjs')
const { normalizeExecutionConfig } = require('../packages/benchmark-protocol/execution.cjs')
const { executionCapabilities } = require('../services/executor/src/execution-config.cjs')
const { toolchainEnvironment, ensureBuildTools } = require('../services/executor/src/xgovernor/toolchain.cjs')

function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-auto-'))
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const root = path.join(home, 'dependencies/xgovernor')
  const events: string[] = []
  let installed = false
  const options: any = {
    root, target: { platform: 'linux', arch: 'x64' }, env: { AGENT_INSIGHT_HOME: home, AGENT_INSIGHT_USER_HOME: home, SHELL: '/bin/bash' }, log() {},
    manager: { status() { return { installed, revision: COMPATIBLE_REVISION } }, async update(version: string) { assert.equal(version, COMPATIBLE_REVISION); events.push('build'); installed = true } },
    async ensureBuildTools() { events.push('tools') },
    async command(file: string, args: string[]) { assert.equal(file, 'docker'); assert.deepEqual(args.slice(0, 3), ['--host', 'unix:///var/run/docker.sock', 'info']); events.push('docker'); return 'linux 2' },
  }
  return { home, root, events, options }
}
test('one install selects native runtimes, pins build, preserves MCTS and reuses matching release', async t => {
  const f = fixture(t)
  const mcts = path.join(f.home, 'mcts')
  fs.mkdirSync(mcts); fs.writeFileSync(path.join(mcts, 'config.env'), 'XGOVERNOR_BASE_URL=http://127.0.0.1:8787\n')
  await installSelectedBackend({ ...f.options, frameworks: 'pi-agent,xiaoo,mcts-xgovernor' })
  assert.deepEqual(f.events, ['tools', 'build', 'docker'])
  assert.deepEqual(readSetup(f.root).platforms, ['pi-agent', 'xiaoo'])
  assert.equal(readSetup(f.root).ready, true)
  assert.equal(fs.readFileSync(path.join(mcts, 'config.env'), 'utf8'), 'XGOVERNOR_BASE_URL=http://127.0.0.1:8787\n')
  f.events.length = 0
  await installSelectedBackend({ ...f.options, frameworks: 'pi-agent' })
  assert.deepEqual(f.events, ['docker'])
  assert.deepEqual(readSetup(f.root).platforms, ['pi-agent'])
  assert.equal(fs.existsSync(path.join(f.root, 'setup.lock')), false)
})
test('MCTS-only selection performs no native dependency installation or configuration', async t => {
  const f = fixture(t)
  assert.deepEqual(await installSelectedBackend({ ...f.options, frameworks: 'mcts-xgovernor' }), { skipped: true })
  assert.equal(fs.existsSync(f.root), false)
  assert.deepEqual(f.events, [])
})
test('build failure and unsupported host are reported without marking sandbox ready', async t => {
  const f = fixture(t)
  f.options.manager.update = async () => { throw new Error('compile failed') }
  assert.equal((await installSelectedBackend({ ...f.options, frameworks: 'xiaoo' })).ready, false)
  assert.match(readSetup(f.root).note, /compile failed/)
  assert.equal(fs.existsSync(path.join(f.root, 'setup.lock')), false)
  f.events.length = 0
  await installSelectedBackend({ ...f.options, frameworks: 'pi-agent', target: { platform: 'darwin', arch: 'arm64' } })
  assert.deepEqual(f.events, [])
  assert.equal(readSetup(f.root).ready, false)
})
test('cgroup failure stays actionable and concurrent setup does not mutate existing state', async t => {
  const f = fixture(t)
  await installSelectedBackend({ ...f.options, frameworks: 'pi-agent', command: async () => 'linux 1' })
  assert.match(readSetup(f.root).note, /cgroup v2/)
  const before = fs.readFileSync(path.join(f.root, 'setup.json'), 'utf8')
  fs.writeFileSync(path.join(f.root, 'setup.lock'), 'fixture')
  assert.equal((await installSelectedBackend({ ...f.options, frameworks: 'xiaoo' })).ready, false)
  assert.equal(fs.readFileSync(path.join(f.root, 'setup.json'), 'utf8'), before)
})
test('Pi resolves experiment selection, endpoint and credential through native SDK using original files', async t => {
  const f = fixture(t)
  const agentDir = path.join(f.home, 'pi')
  fs.mkdirSync(agentDir)
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'custom', defaultModel: 'default' }))
  let requested = ''
  const native = { getError() {}, getModel(provider: string, name: string) { requested = `${provider}/${name}`; return { provider, id: name, api: 'openai-completions', baseUrl: 'https://example.com/v1' } }, isUsingOAuth: () => false, isUsingSubscription: () => false }
  const sdk = async () => ({ ModelRuntime: { async create(options: any) {
    if (options.modelsPath === null) return { getModel() {} }
    assert.equal(options.modelsPath, path.join(agentDir, 'models.json')); assert.equal(options.authPath, path.join(agentDir, 'auth.json')); return native
  } }, ModelRegistry: class { async getApiKeyAndHeaders() { return { ok: true, apiKey: 'native-secret' } } } })
  const env = { HOME: f.home, PI_CODING_AGENT_DIR: agentDir }
  const resolved = await resolvePi('custom/selected', {}, env, sdk)
  assert.equal(requested, 'custom/selected')
  assert.equal(resolved.credential, 'native-secret')
  assert.equal(resolved.model.apiBase, 'https://example.com/v1')
  assert.equal(JSON.stringify(resolved.model).includes('native-secret'), false)
  await resolvePi('', {}, env, sdk)
  assert.equal(requested, 'custom/default')
  native.isUsingOAuth = () => true
  await assert.rejects(resolvePi('custom/selected', {}, env, sdk), /OAuth/)
})
test('xiaoO reuses original provider endpoint and env key, honours selected model and refuses provider mismatch', async t => {
  const f = fixture(t)
  const env = { HOME: f.home, XIAOO_CONFIG: path.join(f.home, 'custom.toml'), NATIVE_KEY: 'xiaoo-secret' }
  const read = async (file: string) => { assert.equal(file, env.XIAOO_CONFIG); return { provider: 'custom', model: 'default', api_base: 'https://example.com/v1', api_key_env: 'NATIVE_KEY' } }
  const resolved = await resolveXiaoo('custom/experiment-model', env, read)
  assert.equal(resolved.model.model, 'experiment-model')
  assert.equal(resolved.credential, 'xiaoo-secret')
  assert.equal((await resolveXiaoo('', env, read)).model.model, 'default')
  await assert.rejects(resolveXiaoo('other/model', env, read), /provider/)
  await assert.rejects(resolveXiaoo('', { ...env, NATIVE_KEY: '' }, read), /凭据/)
})
test('selected legacy override only resolves selected credential and keeps it out of model descriptors', async () => {
  const resolved = await resolveNative({ override: { provider: 'p', model: 'm', apiKeyEnv: 'SELECTED_KEY' } }, { env: { SELECTED_KEY: 'one-secret' } })
  assert.equal(resolved.credential, 'one-secret')
  assert.equal(resolved.model.apiKeyEnv, 'AGENT_INSIGHT_CASE_MODEL_KEY')
  assert.equal(JSON.stringify(resolved.model).includes('one-secret'), false)
})
test('credential subprocess reads inherited env without putting key in arguments or config', async t => {
  const f = fixture(t)
  fs.mkdirSync(f.root, { recursive: true })
  fs.writeFileSync(path.join(f.root, 'setup.json'), JSON.stringify({ context: { home: f.home, SHELL: '/bin/bash' } }))
  const resolved = await resolveModel({ agentConfig: { model: 'p/m' } }, { kind: 'pi' }, { models: { 'p/m': { provider: 'p', model: 'm', apiKeyEnv: 'KEY' }, 'other/model': { apiKeyEnv: 'MISSING_KEY' } } }, { root: f.root, env: { ...process.env, AGENT_INSIGHT_HOME: f.home, KEY: 'subprocess-secret' } })
  assert.equal(resolved.credential, 'subprocess-secret')
  assert.equal(resolved.model.model, 'm')
  assert.equal(fs.readFileSync(path.join(f.root, 'setup.json'), 'utf8').includes('subprocess-secret'), false)
})
test('Trace uses existing curl-installed credential without mutating process environment', async t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.home, '.env'), 'AGENT_INSIGHT_API_KEY="collector-secret"\n')
  assert.equal(traceApiKey({ traceApiKeyEnv: 'AGENT_INSIGHT_API_KEY' }, { AGENT_INSIGHT_HOME: f.home }), 'collector-secret')
  assert.equal(traceApiKey({ traceApiKeyEnv: 'CUSTOM' }, { AGENT_INSIGHT_HOME: f.home, CUSTOM: 'explicit' }), 'explicit')
})
test('backend readiness does not require model credentials', async t => {
  const f = fixture(t)
  const server = path.join(f.home, 'server'); const docker = path.join(f.home, 'docker')
  fs.writeFileSync(server, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  fs.writeFileSync(docker, '#!/bin/sh\necho "linux 2"\n', { mode: 0o755 })
  const config = normalizeExecutionConfig({ profiles: { 'xgovernor-local-docker': { serverExecutable: server, dockerExecutable: docker, runtimes: { xiaoo: { kind: 'xiaoo', namespace: 'xiaoo', agents: ['defaultagent'], workerExecutable: server } } } } })
  const result = executionCapabilities({ config, env: { AGENT_INSIGHT_HOME: f.home, AGENT_INSIGHT_API_KEY: 'fixture' }, os: 'linux', refresh: true })
  assert.equal(result.profiles[0].ready, true)
  assert.deepEqual(result.profiles[0].profile.models, [])
})
test('toolchain bootstrap keeps Rust in managed directory and limits build parallelism', async t => {
  const f = fixture(t)
  const calls: any[] = []
  await ensureBuildTools({ root: f.root, env: { PATH: '/usr/bin' }, target: { platform: 'linux', arch: 'x64' }, log() {}, command: async (file: string, args: string[], options: any) => {
    calls.push({ file, args, options })
    if (file === 'cargo') throw new Error('missing')
    return file === 'node' ? 'v24.13.0' : 'present'
  } })
  const install = calls.find(call => call.file === 'sh')
  assert.ok(install.args.includes('--no-modify-path'))
  assert.equal(install.options.env.CARGO_HOME, path.join(f.root, 'toolchain/cargo'))
  assert.equal(install.options.env.RUSTUP_HOME, path.join(f.root, 'toolchain/rustup'))
  assert.equal(toolchainEnvironment(f.root, {}).CARGO_BUILD_JOBS, '2')
  assert.equal(calls.some(call => /kill|systemctl/.test(call.file)), false)
})

test('xiaoO credential resolution parses actual TOML in a subprocess and keeps parser errors secret', async t => {
  const f = fixture(t)
  const file = path.join(f.home, 'config.toml')
  fs.writeFileSync(file, '[llm]\nprovider = "custom"\nmodel = "default"\napi_base = "https://example.com/v1" # original endpoint\napi_key_env = "EXISTING_MODEL_KEY"\n')
  const env = { ...process.env, HOME: f.home, AGENT_INSIGHT_HOME: f.home, XIAOO_CONFIG: file, EXISTING_MODEL_KEY: 'test-key' }
  const resolved = await resolveXiaoo('custom/from-experiment', env)
  assert.equal(resolved.model.model, 'from-experiment')
  assert.equal(resolved.model.apiBase, 'https://example.com/v1')
  assert.equal(resolved.credential, 'test-key')
  fs.writeFileSync(file, '[llm]\nprovider = "sensitive-unclosed-value\n')
  await assert.rejects(resolveXiaoo('custom/from-experiment', env), (cause: Error) => !cause.message.includes('sensitive-unclosed-value') && cause.message.includes('TOML'))
})
