'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const { installationRoot } = require('./installation.cjs')
const { readSetup } = require('./setup.cjs')
const { toolchainEnvironment } = require('./toolchain.cjs')
const { collectorEnvironment } = require('./credentials.cjs')
const { error } = require('./client.cjs')
const APIS = ['openai-completions', 'openai-responses', 'anthropic-messages']
const MODEL_KEY = 'AGENT_INSIGHT_CASE_MODEL_KEY'
function invalid(message) { return error('MODEL_CONFIGURATION_INVALID', message) }
function json(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (cause) { if (cause.code === 'ENOENT') return fallback; throw invalid('Agent 模型配置不是合法 JSON') }
}
function validateResolved(model, credential) {
  if (!model?.provider || !model?.model) throw invalid('请选择模型或配置 Agent 的默认模型')
  if (model.api && !APIS.includes(model.api)) throw invalid('所选模型的 API 协议尚不支持 xGovernor 执行')
  if (model.apiBase) {
    let url
    try { url = new URL(model.apiBase) } catch { throw invalid('Agent 模型 endpoint 不合法') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw invalid('Agent 模型 endpoint 含不支持的认证信息或参数')
  }
  if (typeof credential !== 'string' || !credential.trim()) throw invalid('所选模型凭据不可用，请完成原有 Agent 的模型配置或登录')
  return { model: { ...model, apiKeyEnv: MODEL_KEY }, credential }
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
  if (!auth.ok) throw invalid('Pi 无法解析所选模型凭据')
  if (Object.keys(auth.headers || {}).length || Object.keys(model.headers || {}).length || Object.keys(model.compat || {}).length) throw invalid('所选 Pi 模型要求自定义 headers/兼容参数，当前 xGovernor 契约尚不支持')
  return validateResolved({ provider, model: name, api: model.api, apiBase: auth.baseUrl || model.baseUrl }, auth.apiKey)
}
async function readXiaoo(file, env) {
  const { execFile } = require('node:child_process')
  const script = 'import json,sys\ntry:\n import tomllib\nexcept ImportError:\n import tomli as tomllib\nwith open(sys.argv[1],"rb") as f: print(json.dumps(tomllib.load(f).get("llm",{})))'
  const home = env.AGENT_INSIGHT_HOME || path.join(os.homedir(), '.agent-insight')
  const client = json(path.join(home, 'client/config.json'))
  const candidates = [...new Set([client.fiPython, 'python3.13', 'python3.12', 'python3.11', 'python3'].filter(Boolean))]
  for (const python of candidates) {
    try {
      const text = await new Promise((resolve, reject) => execFile(python, ['-c', script, file], { env, timeout: 5000, maxBuffer: 65536 }, (cause, stdout) => cause ? reject(cause) : resolve(stdout)))
      return JSON.parse(text)
    } catch {}
  }
  throw invalid('无法读取 xiaoO config.toml；请确认 TOML 格式及 Python 3.11+（或 tomli）可用')
}
async function resolveXiaoo(modelId, env, read = readXiaoo) {
  const home = env.AGENT_INSIGHT_USER_HOME || env.HOME || os.homedir()
  const file = (env.XIAOO_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'xiaoo/config.toml')).replace(/^~(?=\/)/, home)
  const llm = await read(file, env)
  const selected = modelId || (llm.provider && llm.model ? `${llm.provider}/${llm.model}` : '')
  const split = selected.indexOf('/')
  if (split < 1 || selected.slice(0, split) !== llm.provider) throw invalid('实验所选 provider 与 xiaoO 原有配置不一致，请先配置该 provider')
  return validateResolved({ provider: llm.provider, model: selected.slice(split + 1), ...(llm.api_base ? { apiBase: llm.api_base } : {}), ...(llm.api ? { api: llm.api } : {}) }, env[llm.api_key_env])
}
async function resolveNative(input, options = {}) {
  const env = collectorEnvironment(options.env || process.env)
  if (input.override) {
    const { apiKeyEnv, ...model } = input.override
    return validateResolved(model, env[apiKeyEnv])
  }
  if (input.runtime.kind === 'pi') return resolvePi(input.modelId, input.runtime, env, options.loadSdk)
  if (input.runtime.kind === 'xiaoo') return resolveXiaoo(input.modelId, env, options.readXiaoo)
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
      if (code || result.error) return reject(invalid(result.error || 'Agent 模型解析失败'))
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
      fs.writeSync(3, JSON.stringify({ error: cause.code === 'MODEL_CONFIGURATION_INVALID' ? cause.message : 'Agent 模型或凭据解析失败，请检查原有配置' }))
      process.exitCode = 1
    }
  })
}
module.exports = { resolveModel, resolveNative, resolvePi, resolveXiaoo, validateResolved, MODEL_KEY }
