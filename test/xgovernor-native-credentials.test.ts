import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createRequire } from 'node:module'
import { writeXiaooCredentialBridge } from './helpers/xiaoo-credential-bridge'
const require = createRequire(import.meta.url)
const { readNativeCredentials } = require('../services/executor/src/xgovernor/xiaoo-credentials.cjs')
const { resolveModel, resolveXiaoo, resolvePi } = require('../services/executor/src/xgovernor/model-resolver.cjs')
const { buildNativeCredentials } = require('../services/executor/src/xgovernor/native-credentials-build.cjs')

function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-credentials-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const llm = { provider: 'local', model: 'chosen', api_base: 'http://127.0.0.1:9/v1', api_key_env: 'API_KEY', max_tokens: 100 }

test('native credential bridge returns only the selected credential over fd3, ignoring stdout and stderr', async t => {
  const dir = fixture(t)
  const credentialExecutable = writeXiaooCredentialBridge(dir, llm, { schemaVersion: 1, llm, credential: 'store-fixture' })
  fs.appendFileSync(credentialExecutable, '\nconsole.log("unrelated-output-secret"); console.error("unrelated-error-secret");\n')
  const resolved = await resolveXiaoo('local/chosen', { HOME: dir, API_KEY: 'different-environment-fixture' }, undefined, { credentialExecutable })
  assert.equal(resolved.credential, 'store-fixture')
  assert.deepEqual(resolved.model.capabilities, { max_tokens: 100 })
  assert.equal(JSON.stringify(resolved.model).includes('store-fixture'), false)
})

test('bridge diagnostics distinguish missing reference, unreadable store and unsupported adapter without exposing arbitrary errors', async t => {
  const dir = fixture(t)
  for (const [nativeCode, code, detail] of [
    ['MODEL_CREDENTIAL_MISSING', 'MODEL_CREDENTIAL_MISSING', /原生凭据库.*客户端运行环境.*API_KEY/],
    ['MODEL_CREDENTIAL_STORE_UNREADABLE', 'MODEL_CREDENTIAL_STORE_UNREADABLE', /读取或解密.*llm_secrets.json/],
    ['MODEL_PROVIDER_UNSUPPORTED', 'MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE', /不代表模型或 Key 无效/],
    ['MODEL_PROFILE_INVALID', 'MODEL_CONFIGURATION_INVALID', /active_profile\/provider\/model/],
    ['MODEL_CONFIG_UNREADABLE', 'MODEL_CONFIGURATION_INVALID', /执行账号.*文件权限/],
  ] as const) {
    const credentialExecutable = writeXiaooCredentialBridge(dir, llm, { schemaVersion: 1, error: nativeCode, environment: 'API_KEY', message: 'secret-not-for-display' })
    await assert.rejects(readNativeCredentials('/config.toml', 'local/chosen', { credentialExecutable }, {}), (cause: any) => {
      assert.equal(cause.code, code)
      assert.match(cause.message, detail)
      assert.match(cause.message, /模型请求尚未发出/)
      assert.equal(cause.message.includes('secret-not-for-display'), false)
      return true
    })
  }
})

test('missing executable, malformed/unknown protocol and no-key provider do not masquerade as missing user credentials', async t => {
  const dir = fixture(t)
  await assert.rejects(readNativeCredentials('/config.toml', '', {}, {}), { code: 'MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE' })
  await assert.rejects(readNativeCredentials('/config.toml', '', { credentialExecutable: path.join(dir, 'absent') }, {}), { code: 'MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE' })
  for (const response of [{ schemaVersion: 9 }, { schemaVersion: 1, error: 'secret-raw-error' }, { schemaVersion: 1, llm, credential: null, credentialRequired: false }]) {
    const credentialExecutable = writeXiaooCredentialBridge(dir, llm, response)
    await assert.rejects(readNativeCredentials('/config.toml', '', { credentialExecutable }, {}), (cause: any) => cause.code === 'MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE' && !cause.message.includes('secret-raw-error'))
  }
})

test('credential codes and actionable messages survive the login shell/private subprocess boundary', async t => {
  const dir = fixture(t)
  const root = path.join(dir, 'dependencies/xgovernor')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'setup.json'), JSON.stringify({ context: { home: dir, SHELL: '/bin/bash' } }))
  const runtime = { kind: 'xiaoo', credentialExecutable: writeXiaooCredentialBridge(dir, llm, { schemaVersion: 1, error: 'MODEL_CREDENTIAL_STORE_UNREADABLE' }) }
  const options = { root, env: { ...process.env, HOME: dir, AGENT_INSIGHT_HOME: dir } }
  await assert.rejects(resolveModel({ agentConfig: { model: 'local/chosen' } }, runtime, { models: {} }, options), (cause: any) => cause.code === 'MODEL_CREDENTIAL_STORE_UNREADABLE' && /Vault\/SDF/.test(cause.message))
  writeXiaooCredentialBridge(dir, llm, { schemaVersion: 1, llm, credential: 'private-store-fixture' })
  const resolved = await resolveModel({ agentConfig: { model: 'local/chosen' } }, runtime, { models: {} }, options)
  assert.equal(resolved.credential, 'private-store-fixture')
  assert.equal(fs.readFileSync(path.join(root, 'setup.json'), 'utf8').includes('private-store-fixture'), false)
})

test('Pi still delegates credential parsing to its native SDK, including failure and unsupported OAuth', async t => {
  const dir = fixture(t)
  let ok = false; let oauth = false
  const model = { provider: 'deepseek', id: 'chosen', api: 'openai-completions' }
  const sdk = async () => ({
    ModelRuntime: { async create() { return { getError() {}, getModel: () => model, isUsingOAuth: () => oauth, isUsingSubscription: () => false } } },
    ModelRegistry: class { async getApiKeyAndHeaders() { return { ok, apiKey: ok ? 'pi-native-fixture' : undefined, message: 'private-sdk-error' } } },
  })
  await assert.rejects(resolvePi('deepseek/chosen', {}, { HOME: dir }, sdk), (cause: any) => cause.code === 'MODEL_CREDENTIAL_MISSING' && /Pi.*原生 SDK.*尚未发出/.test(cause.message) && !cause.message.includes('private-sdk-error'))
  ok = true
  const resolved = await resolvePi('deepseek/chosen', {}, { HOME: dir }, sdk)
  assert.equal(resolved.credential, 'pi-native-fixture')
  oauth = true
  await assert.rejects(resolvePi('deepseek/chosen', {}, { HOME: dir }, sdk), /OAuth/)
})

test('installer builds the bridge using the xGovernor-locked xiaoo source rather than a separate crypto implementation', async t => {
  const dir = fixture(t)
  const native = path.join(dir, 'native')
  const provider = path.join(native, 'apps/shared/src/gateway/decrypted_api_keys.rs')
  fs.mkdirSync(path.dirname(provider), { recursive: true })
  fs.writeFileSync(provider, 'native fixture')
  fs.writeFileSync(path.join(dir, 'Cargo.lock'), 'locked upstream dependencies')
  const calls: any[] = []
  const source = 'git+https://gitcode.com/openeuler/xiaoO.git?rev=locked#revision'
  const result = await buildNativeCredentials(dir, async (file: string, args: string[], cwd: string, verbose: boolean, maxOutputBytes: number) => {
    calls.push({ file, args, cwd, verbose, maxOutputBytes })
    if (args[0] === 'metadata') return JSON.stringify({ packages: [{ name: 'llm-client', source, manifest_path: path.join(native, 'crates/llm-client/Cargo.toml') }] })
    if (args[0] === '--describe') return '{"schemaVersion":1,"bridgeVersion":1}'
    return ''
  })
  assert.deepEqual(result, { version: 1, source })
  const manifest = fs.readFileSync(path.join(dir, 'insight-native-credentials/Cargo.toml'), 'utf8')
  assert.ok(manifest.includes(path.join(native, 'apps/vault')))
  assert.ok(manifest.includes(path.join(native, 'crates/llm-client')))
  assert.equal(fs.readFileSync(path.join(dir, 'insight-native-credentials/Cargo.lock'), 'utf8'), 'locked upstream dependencies')
  assert.ok(calls.some(call => call.args.includes('--locked')))
  assert.ok(fs.readFileSync(path.join(dir, 'insight-native-credentials/src/main.rs'), 'utf8').includes(JSON.stringify(provider)))
  assert.equal(calls[0].maxOutputBytes, 32 * 1024 * 1024)
})
