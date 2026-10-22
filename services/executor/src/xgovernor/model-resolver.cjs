'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { isDeepStrictEqual } = require('node:util')
const { installationRoot } = require('./installation.cjs')
const { readSetup } = require('./setup.cjs')
const { toolchainEnvironment } = require('./toolchain.cjs')
const { collectorEnvironment } = require('./credentials.cjs')
const { error } = require('./client.cjs')
const { readNativeCredentials } = require('./xiaoo-credentials.cjs')
const CREDENTIAL_CODES = new Set(['MODEL_CONFIGURATION_INVALID', 'MODEL_CREDENTIAL_MISSING', 'MODEL_CREDENTIAL_STORE_UNREADABLE', 'MODEL_CREDENTIAL_ADAPTER_UNAVAILABLE'])
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const MODEL_KEY = 'AGENT_INSIGHT_CASE_MODEL_KEY'
function invalid(message) { return error('MODEL_CONFIGURATION_INVALID', message) }
function json(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (cause) { if (cause.code === 'ENOENT') return fallback; throw invalid('Agent 模型配置不是合法 JSON') }
}
function capabilities(value) {
  if (value == null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('模型 capabilities 必须为对象')
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (!['reasoning', 'input', 'context_window', 'max_tokens'].includes(key)) throw invalid('模型 capabilities 包含不支持的字段')
    if (item == null) continue
    if (key === 'reasoning' && typeof item !== 'boolean') throw invalid('模型 reasoning 必须为布尔值')
    if (key === 'input' && (!Array.isArray(item) || !item.length || item.some(input => !['text', 'image'].includes(input)))) throw invalid('模型 input 必须包含 text 或 image')
    if (['context_window', 'max_tokens'].includes(key) && (!Number.isInteger(item) || item < 1 || item > 0xffffffff)) throw invalid(`模型 ${key} 必须为正整数且不超过 u32 上限`)
    result[key] = Array.isArray(item) ? [...item] : item
  }
  if (result.context_window && result.max_tokens > result.context_window) throw invalid('模型 max_tokens 不能超过 context_window')
  return Object.keys(result).length ? result : undefined
}
function reasoningEffort(value) {
  if (value == null) return undefined
  const aliases = { off: 'off', none: 'off', disabled: 'off', high: 'high', max: 'max', xhigh: 'max', maximum: 'max' }
  const effort = typeof value === 'string' && Object.hasOwn(aliases, value.trim().toLowerCase()) ? aliases[value.trim().toLowerCase()] : undefined
  if (!effort) throw invalid('xiaoO reasoning_effort 仅支持 off、high、max（及其原生别名）')
  return effort
}
function validateResolved(model, credential, agent = 'Agent') {
  if (!model?.provider || !model?.model) throw invalid('请选择模型或配置 Agent 的默认模型')
  if (model.api && !APIS.includes(model.api)) throw invalid('所选模型的 API 协议尚不支持 xGovernor 执行')
  if (model.apiBase) {
    let url
    try { url = new URL(model.apiBase) } catch { throw invalid('Agent 模型 endpoint 不合法') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('Agent 模型 endpoint 含不支持的认证信息或参数')
  }
  const caps = capabilities(model.capabilities)
  const effort = reasoningEffort(model.reasoningEffort)
  if (caps?.reasoning === false && effort && effort !== 'off') throw invalid('模型不支持推理，不能启用 reasoning_effort')
  if (typeof credential !== 'string' || !credential.trim()) throw error('MODEL_CREDENTIAL_MISSING', `${agent} 未提供所选模型的非空凭据，请检查执行机器上的原生模型配置；模型请求尚未发出`)
  return { model: { provider: model.provider, model: model.model, ...(model.api ? { api: model.api } : {}), ...(model.apiBase ? { apiBase: model.apiBase } : {}),
    ...(caps ? { capabilities: caps } : {}), ...(effort ? { reasoningEffort: effort } : {}), apiKeyEnv: MODEL_KEY }, credential }
}
async function resolvePi(modelId, runtime, env, loadSdk) {
  const home = env.AGENT_INSIGHT_USER_HOME || env.HOME || os.homedir()
  const dir = (env.PI_CODING_AGENT_DIR || path.join(home, '.pi/agent')).replace(/^~(?=\/)/, home)
  const settings = json(path.join(dir, 'settings.json'))
  const selected = modelId || (settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : '')
  const split = selected.indexOf('/')
  if (split < 1) throw invalid('请选择 Pi 模型或在 Pi 中设置默认 provider/model')
  const provider = selected.slice(0, split); const name = selected.slice(split + 1)
  const sdk = loadSdk ? await loadSdk() : await import(pathToFileURL(path.join(runtime.extensionDirectory, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href)
  const native = await sdk.ModelRuntime.create({ authPath: path.join(dir, 'auth.json'), modelsPath: path.join(dir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false })
  if (native.getError()) throw invalid('Pi 模型配置加载失败，请检查原有 models.json')
  const model = native.getModel(provider, name)
  if (!model) throw invalid('实验选择的模型不在 Pi 原有模型配置中')
  if (native.isUsingOAuth(provider) || native.isUsingSubscription(provider)) throw invalid('该 Pi 模型使用 OAuth/订阅认证，当前 xGovernor 适配暂不支持；请使用已有的 API Key 模型')
  const registry = new sdk.ModelRegistry(native)
  const auth = await registry.getApiKeyAndHeaders(model)
  if (!auth.ok) throw error('MODEL_CREDENTIAL_MISSING', 'Pi 原生 SDK 未能取得所选模型凭据，请检查执行机器上的 Pi auth.json、models.json 或其凭据引用；模型请求尚未发出')
  // Pi 桥接从内置目录重建模型，只能保留与该目录一致的兼容配置。
  const catalog = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false })
  const builtin = catalog.getModel(provider, name)
  const custom = []
  const actualCompat = model.compat || {}; const builtinCompat = builtin?.compat || {}
  for (const key of new Set([...Object.keys(actualCompat), ...Object.keys(builtinCompat)])) {
    if (!isDeepStrictEqual(actualCompat[key], builtinCompat[key])) custom.push(`compat.${key}`)
  }
  const headers = value => Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key.toLowerCase(), item]))
  const actualHeaders = { ...headers(model.headers), ...headers(auth.headers) }
  if (!isDeepStrictEqual(actualHeaders, headers(builtin?.headers))) custom.push('headers')
  if (custom.length) throw invalid(`所选 Pi 模型包含当前 xGovernor 桥接无法保留的自定义配置：${custom.join('、')}`)
  return validateResolved({ provider, model: name, api: model.api, apiBase: auth.baseUrl || model.baseUrl,
    capabilities: { reasoning: model.reasoning, input: model.input, context_window: model.contextWindow, max_tokens: model.maxTokens },
  }, auth.apiKey, 'Pi')
}
async function resolveXiaoo(modelId, env, read, runtime = {}) {
  const home = env.AGENT_INSIGHT_USER_HOME || env.HOME || os.homedir()
  const file = (env.XIAOO_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'xiaoo/config.toml')).replace(/^~(?=\/)/, home)
  const native = read ? null : await readNativeCredentials(file, modelId, runtime, env)
  const llm = native ? native.llm : await read(file, env)
  const selected = modelId || (llm.provider && llm.model ? `${llm.provider}/${llm.model}` : '')
  const split = selected.indexOf('/')
  if (split < 1 || selected.slice(0, split) !== llm.provider) throw invalid('实验所选 provider 与 xiaoO 原有配置不一致，请先配置该 provider')
  for (const key of ['kvcache_enabled', 'kvcache_debug_enabled']) {
    if (llm[key] != null && typeof llm[key] !== 'boolean') throw invalid(`xiaoO ${key} 必须为布尔值`)
    if (llm[key] === true) throw invalid(`xiaoO ${key}=true 当前 xGovernor 契约尚不支持`)
  }
  return validateResolved({ provider: llm.provider, model: selected.slice(split + 1), ...(llm.api_base ? { apiBase: llm.api_base } : {}), ...(llm.api ? { api: llm.api } : {}),
    capabilities: { max_tokens: llm.max_tokens, context_window: llm.context_window }, reasoningEffort: llm.reasoning_effort,
  }, native ? native.credential : env[llm.api_key_env], 'xiaoo')
}
async function resolveNative(input, options = {}) {
  const env = collectorEnvironment(options.env || process.env)
  if (input.override) {
    const { apiKeyEnv, ...model } = input.override
    return validateResolved(model, env[apiKeyEnv])
  }
  if (input.runtime.kind === 'pi') return resolvePi(input.modelId, input.runtime, env, options.loadSdk)
  if (input.runtime.kind === 'xiaoo') return resolveXiaoo(input.modelId, env, options.readXiaoo, input.runtime)
  throw invalid('此 Runtime 尚未实现原生模型凭据适配')
}
async function resolveModel(task, runtime, local, options = {}) {
  const root = options.root || installationRoot(options.env)
  const context = readSetup(root).context || {}
  const env = toolchainEnvironment(root, { ...(options.env || process.env), ...Object.fromEntries(Object.entries(context).filter(([key]) => key !== 'home')), ...(context.home ? { HOME: context.home, AGENT_INSIGHT_USER_HOME: context.home } : {}) })
  const modelId = task.agentConfig.model || runtime.defaultModel || (Object.keys(local.models).length === 1 ? Object.keys(local.models)[0] : '')
  const input = { modelId, runtime, override: local.models[modelId], context }
  const node = fs.existsSync(path.join(root, 'toolchain/node/bin/node')) ? path.join(root, 'toolchain/node/bin/node') : process.execPath
  const shell = env.SHELL && /\/(?:ba|z)?sh$/.test(env.SHELL) ? env.SHELL : '/bin/bash'
  return new Promise((resolve, reject) => {
    const args = shell.endsWith('/bash') || shell.endsWith('/sh') && process.platform === 'darwin'
      ? ['--noprofile', '--norc', '-ic', 'exec 20>&3 3>&- || exit; exec "$@"', 'insight-model-bootstrap', shell, '-lic', 'exec 3>&20 20>&- || exit; exec "$@"', 'insight-model', node, __filename]
      : ['-lic', 'exec "$@"', 'insight-model', node, __filename]
    const child = (options.spawn || spawn)(shell, args, { env, cwd: context.home || os.homedir(), stdio: ['pipe', 'ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' })
    let output = ''; let overflow = false
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    const timer = setTimeout(stop, 30000)
    const abort = () => stop()
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdio[3].on('data', chunk => { output += chunk; if (output.length > 1024 * 1024) { overflow = true; stop() } })
    child.stdin.on('error', () => {})
    child.on('error', () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(invalid('无法启动 Agent 凭据解析进程')) })
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      if (options.signal?.aborted) return reject(options.signal.reason)
      if (overflow) return reject(invalid('Agent 凭据解析输出超限'))
      let result
      try { result = JSON.parse(output) } catch { return reject(invalid('Agent 模型解析失败或超时，请检查原有配置及登录环境')) }
      if (code || result.error) return reject(error(CREDENTIAL_CODES.has(result.code) ? result.code : 'MODEL_CONFIGURATION_INVALID', result.error || 'Agent 模型解析失败'))
      try { resolve(validateResolved(result.model, result.credential)) } catch (cause) { reject(cause) }
    })
    child.stdin.end(JSON.stringify(input))
    if (options.signal?.aborted) stop()
  })
}
if (require.main === module) {
  let input = ''
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', async () => {
    try {
      const request = JSON.parse(input)
      for (const [key, value] of Object.entries(request.context || {})) if (key !== 'home') process.env[key] = value
      if (request.context?.home) process.env.AGENT_INSIGHT_USER_HOME = request.context.home
      fs.writeSync(3, JSON.stringify(await resolveNative(request)))
    } catch (cause) {
      fs.writeSync(3, JSON.stringify({ code: CREDENTIAL_CODES.has(cause.code) ? cause.code : 'MODEL_CONFIGURATION_INVALID', error: CREDENTIAL_CODES.has(cause.code) ? cause.message : 'Agent 模型或凭据解析失败，请检查原有配置' }))
      process.exitCode = 1
    }
  })
}
module.exports = { resolveModel, resolveNative, resolvePi, resolveXiaoo, validateResolved, MODEL_KEY }
