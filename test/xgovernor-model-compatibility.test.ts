import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { resolvePi, resolveXiaoo, resolveModel, validateResolved } = require('../services/executor/src/xgovernor/model-resolver.cjs')

function home(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xgov-model-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

const deepseek = {
  provider: 'deepseek', id: 'deepseek-v4-flash', api: 'openai-completions', baseUrl: 'https://model.example/v1',
  reasoning: true, input: ['text'], contextWindow: 1048576, maxTokens: 128000,
  compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek' },
}

function piSdk(model: Record<string, unknown> = deepseek, builtin: unknown = deepseek, authHeaders: Record<string, string> = {}) {
  return async () => ({
    ModelRuntime: { async create(options: { modelsPath: string | null; refreshOnCreate: boolean; allowModelNetwork: boolean }) {
      assert.equal(options.refreshOnCreate, false)
      assert.equal(options.allowModelNetwork, false)
      return options.modelsPath === null ? { getModel: () => builtin } : {
        getError() {}, getModel: () => model, isUsingOAuth: () => false, isUsingSubscription: () => false,
      }
    } },
    ModelRegistry: class { async getApiKeyAndHeaders() { return { ok: true, apiKey: 'fixture-secret', headers: authHeaders } } },
  })
}

test('Pi accepts built-in DeepSeek compatibility and retains its model capabilities', async t => {
  const resolved = await resolvePi('deepseek/deepseek-v4-flash', {}, { HOME: home(t) }, piSdk())
  assert.equal(resolved.model.model, 'deepseek-v4-flash')
  assert.equal(resolved.credential, 'fixture-secret')
  assert.deepEqual(resolved.model.capabilities, { reasoning: true, input: ['text'], context_window: 1048576, max_tokens: 128000 })
  assert.equal(JSON.stringify(resolved.model).includes('fixture-secret'), false)
  assert.equal(resolved.model.compat, undefined, 'The bridge restores built-in compat using the same catalogue')
})

test('Pi compares compatibility structurally, and rejects changed or removed built-in settings by field', async t => {
  const env = { HOME: home(t) }
  const reordered = { ...deepseek, compat: Object.fromEntries(Object.entries(deepseek.compat).reverse()) }
  await assert.doesNotReject(resolvePi('deepseek/deepseek-v4-flash', {}, env, piSdk(reordered as typeof deepseek)))
  const changed = { ...deepseek, compat: { ...deepseek.compat, supportsDeveloperRole: true } }
  await assert.rejects(resolvePi('deepseek/deepseek-v4-flash', {}, env, piSdk(changed)), /compat.supportsDeveloperRole/)
  await assert.rejects(resolvePi('deepseek/deepseek-v4-flash', {}, env, piSdk({ ...deepseek, compat: {} } as typeof deepseek)), /compat.requiresReasoningContentOnAssistantMessages/)
})

test('Pi accepts built-in headers but refuses additional credential headers without exposing their values', async t => {
  const env = { HOME: home(t) }
  const builtin = { ...deepseek, headers: { 'X-Client': 'builtin-client' } }
  await assert.doesNotReject(resolvePi('deepseek/deepseek-v4-flash', {}, env, piSdk(builtin, builtin, { 'x-client': 'builtin-client' })))
  await assert.rejects(resolvePi('deepseek/deepseek-v4-flash', {}, env, piSdk(deepseek, deepseek, { 'X-Custom': 'private-header-value' })), (cause: Error) => cause.message.includes('headers') && !cause.message.includes('private-header-value'))
  await assert.rejects(resolvePi('deepseek/deepseek-v4-flash', {}, env, piSdk({ ...deepseek, headers: { 'X-Custom': 'private-header-value' } })), /headers/)
})

test('Pi supports custom models without compatibility overrides and preserves explicit model limits', async t => {
  const custom = { ...deepseek, provider: 'custom', id: 'chosen', compat: {} }
  const resolved = await resolvePi('custom/chosen', {}, { HOME: home(t) }, piSdk(custom, null))
  assert.equal(resolved.model.provider, 'custom')
  assert.equal(resolved.model.capabilities.max_tokens, 128000)
  await assert.rejects(resolvePi('custom/chosen', {}, { HOME: home(t) }, piSdk(deepseek, null)), /compat/)
})

test('model capabilities reject invalid token limits, input types and reasoning settings', () => {
  for (const capabilities of [{ max_tokens: 0 }, { max_tokens: 1.5 }, { max_tokens: 2 ** 32 }, { context_window: 100, max_tokens: 101 }, { input: [] }, { input: ['audio'] }, { reasoning: 'true' }]) {
    assert.throws(() => validateResolved({ provider: 'custom', model: 'chosen', capabilities }, 'fixture-secret'), (cause: Error & { code: string }) => cause.code === 'MODEL_CONFIGURATION_INVALID')
  }
  assert.throws(() => validateResolved({ provider: 'custom', model: 'chosen', capabilities: { reasoning: false }, reasoningEffort: 'high' }, 'fixture-secret'), /不支持推理/)
})

test('xiaoO inherits selected model, output token budget and all native reasoning levels and aliases', async t => {
  const env = { HOME: home(t), MODEL_KEY: 'fixture-secret' }
  for (const [configured, expected] of [['off', 'off'], ['high', 'high'], ['max', 'max'], ['xhigh', 'max'], ['none', 'off'], ['disabled', 'off'], ['maximum', 'max'], [' HIGH ', 'high']]) {
    const resolved = await resolveXiaoo('custom/selected', env, async () => ({ provider: 'custom', model: 'default', api_base: 'https://model.example/v1', api_key_env: 'MODEL_KEY', max_tokens: 128000, reasoning_effort: configured, kvcache_enabled: false, kvcache_debug_enabled: false }))
    assert.equal(resolved.model.model, 'selected')
    assert.deepEqual(resolved.model.capabilities, { max_tokens: 128000 })
    assert.equal(resolved.model.reasoningEffort, expected)
    assert.equal(resolved.credential, 'fixture-secret')
    assert.equal(JSON.stringify(resolved.model).includes('fixture-secret'), false)
  }
})

test('xiaoO rejects unsupported cache switches and reasoning levels with actionable field names', async t => {
  const env = { HOME: home(t), MODEL_KEY: 'fixture-secret' }
  const config = { provider: 'custom', model: 'default', api_key_env: 'MODEL_KEY' }
  for (const field of ['kvcache_enabled', 'kvcache_debug_enabled']) {
    await assert.rejects(resolveXiaoo('', env, async () => ({ ...config, [field]: true })), new RegExp(field))
    await assert.rejects(resolveXiaoo('', env, async () => ({ ...config, [field]: 'false' })), /布尔值/)
  }
  await assert.rejects(resolveXiaoo('', env, async () => ({ ...config, reasoning_effort: 'medium' })), /reasoning_effort/)
  await assert.rejects(resolveXiaoo('', env, async () => ({ ...config, max_tokens: -1 })), /max_tokens/)
  const resolved = await resolveXiaoo('', env, async () => config)
  assert.equal(resolved.model.capabilities, undefined)
  assert.equal(resolved.model.reasoningEffort, undefined)
})

test('xiaoO TOML capabilities and reasoning survive the private credential subprocess', async t => {
  const directory = home(t)
  const root = path.join(directory, 'dependencies/xgovernor')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'setup.json'), JSON.stringify({ context: { home: directory, SHELL: '/bin/bash' } }))
  const config = path.join(directory, 'config.toml')
  fs.writeFileSync(config, '[llm]\nprovider="custom"\nmodel="default"\napi_base="https://model.example/v1"\napi_key_env="MODEL_KEY"\nmax_tokens=128000\nreasoning_effort="high"\nkvcache_enabled=false\nkvcache_debug_enabled=false\n')
  const resolved = await resolveModel({ agentConfig: { model: 'custom/selected' } }, { kind: 'xiaoo' }, { models: {} }, { root, env: { ...process.env, HOME: directory, AGENT_INSIGHT_HOME: directory, XIAOO_CONFIG: config, MODEL_KEY: 'private-subprocess-secret' } })
  assert.deepEqual(resolved.model.capabilities, { max_tokens: 128000 })
  assert.equal(resolved.model.reasoningEffort, 'high')
  assert.equal(resolved.model.model, 'selected')
  assert.equal(resolved.credential, 'private-subprocess-secret')
  assert.equal(fs.readFileSync(config, 'utf8').includes('private-subprocess-secret'), false)
  assert.equal(fs.readFileSync(path.join(root, 'setup.json'), 'utf8').includes('private-subprocess-secret'), false)
})
