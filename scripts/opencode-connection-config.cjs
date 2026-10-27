const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync, spawn } = require('node:child_process')
const { createHash } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')

const LIMIT = 8 * 1024 * 1024
const SECRET = /(?:api.?key|secret|password|token$|authorization$|cookie$|credential|private.?key)/i
const URL_FIELD = /(?:url|endpoint|proxy)$/i
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const enabled = value => value === '1' || value === 'true'

function configError(reason) {
  return Object.assign(new Error(`OpenCode 客户端连接配置不可用：${reason}；未请求模型，不会回退其他凭据或模型`), { code: 'MODEL_UNAVAILABLE' })
}

function parseJsonc(text) {
  let output = '', quoted = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1]
    if (quoted) {
      output += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') { quoted = true; output += c }
    else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      output += '\n'
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0) throw configError('JSONC 注释不完整')
      output += ' '; i = end + 1
    } else output += c
  }
  let clean = ''; quoted = false; escaped = false
  for (let i = 0; i < output.length; i++) {
    const c = output[i]
    if (quoted) {
      clean += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') { quoted = true; clean += c }
    else if (c !== ',' || !/^\s*[}\]]/.test(output.slice(i + 1))) clean += c
  }
  try {
    return JSON.parse(clean, (key, value) => {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('unsafe key')
      return value
    })
  } catch { throw configError('原始 JSON/JSONC 配置无法解析') }
}

function merge(left, right) {
  if (!record(left) || !record(right)) return right
  const result = { ...left }
  for (const [key, value] of Object.entries(right)) result[key] = merge(result[key], value)
  return result
}

function readText(file, fingerprints, required = false) {
  try {
    const fd = fs.openSync(file, 'r')
    let bytes
    try {
      if (fs.fstatSync(fd).size > LIMIT) throw configError('配置或引用文件超过 8 MiB')
      bytes = fs.readFileSync(fd)
      if (bytes.length > LIMIT) throw configError('配置或引用文件超过 8 MiB')
    } finally { fs.closeSync(fd) }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    fingerprints.push([file, createHash('sha256').update(bytes).digest('hex')])
    return text
  } catch (error) {
    if (error.code === 'ENOENT' && !required) { fingerprints.push([file, null]); return null }
    if (error.code === 'MODEL_UNAVAILABLE') throw error
    throw configError('配置或引用文件缺失、不可读或不是有效 UTF-8')
  }
}

function expand(text, directory, context, fingerprints) {
  text = text.replace(/\{env:([^}]+)\}/g, (_, name) => context.env[name] || '')
  return text.replace(/\{file:([^}]+)\}/g, (token, name, offset) => {
    const prefix = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset).trimStart()
    if (prefix.startsWith('//')) return token
    const file = name.startsWith('~/') ? path.join(context.home, name.slice(2)) : path.resolve(directory, name)
    return JSON.stringify(readText(file, fingerprints, true).trim()).slice(1, -1)
  })
}

function contextFor(options = {}) {
  const env = { ...process.env, ...options.env }
  const home = options.home || env.AGENT_INSIGHT_USER_HOME || env.HOME || os.homedir()
  const cwd = fs.realpathSync(options.cwd || process.cwd())
  const configHome = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
  const dataHome = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode')
  return { env, home, cwd, configHome, dataHome, platform: options.platform || process.platform, temporaryRoot: options.temporaryRoot || os.tmpdir() }
}

function snapshot(context) {
  const { cwd, home, env, configHome, dataHome, platform } = context
  const fingerprints = [], files = []
  const addPair = dir => files.push(path.join(dir, 'opencode.json'), path.join(dir, 'opencode.jsonc'))
  files.push(path.join(configHome, 'config.json')); addPair(configHome)
  if (env.OPENCODE_CONFIG) files.push(path.resolve(cwd, env.OPENCODE_CONFIG))
  const ancestors = []
  for (let dir = cwd;; dir = path.dirname(dir)) {
    ancestors.push(dir)
    if (fs.existsSync(path.join(dir, '.git')) || dir === path.dirname(dir)) break
  }
  if (!enabled(env.OPENCODE_DISABLE_PROJECT_CONFIG)) for (const dir of [...ancestors].reverse()) addPair(dir)
  const directories = [configHome,
    ...(!enabled(env.OPENCODE_DISABLE_PROJECT_CONFIG) ? ancestors.map(dir => path.join(dir, '.opencode')) : []),
    path.join(env.OPENCODE_TEST_HOME || home, '.opencode'), ...(env.OPENCODE_CONFIG_DIR ? [path.resolve(cwd, env.OPENCODE_CONFIG_DIR)] : [])]
  for (const dir of new Set(directories)) if (dir.endsWith('.opencode') || (env.OPENCODE_CONFIG_DIR && dir === path.resolve(cwd, env.OPENCODE_CONFIG_DIR))) addPair(dir)
  let config = {}
  const mergeSource = value => {
    if (!record(value)) throw configError('原始配置必须为对象')
    if (['providers', 'agents', 'mcpServers'].some(key => Object.hasOwn(value, key))) throw configError('暂不支持需要格式转换的连接配置')
    config = merge(config, value)
  }
  const load = file => {
    const text = readText(file, fingerprints)
    if (text === null || !text.trim()) return
    mergeSource(parseJsonc(expand(text, path.dirname(file), context, fingerprints)))
  }
  for (const file of files) load(file)
  if (env.OPENCODE_CONFIG_CONTENT) mergeSource(parseJsonc(expand(env.OPENCODE_CONFIG_CONTENT, cwd, context, fingerprints)))
  const managed = env.OPENCODE_TEST_MANAGED_CONFIG_DIR || (platform === 'win32' ? path.join(env.ProgramData || 'C:\\ProgramData', 'opencode') : platform === 'darwin' ? '/Library/Application Support/opencode' : '/etc/opencode')
  for (const name of ['opencode.json', 'opencode.jsonc']) load(path.join(managed, name))
  if (platform === 'darwin') {
    const user = os.userInfo().username
    for (const dir of ['/Library/Managed Preferences', path.join('/Library/Managed Preferences', user)]) {
      if (fs.existsSync(path.join(dir, 'ai.opencode.managed.plist'))) throw configError('暂不支持 MDM 托管凭据恢复')
    }
  }
  const legacy = readText(path.join(configHome, 'config'), fingerprints)
  if (legacy !== null) throw configError('请先将旧版 TOML 配置迁移为 JSON/JSONC')
  const authText = env.OPENCODE_AUTH_CONTENT || readText(path.join(dataHome, 'auth.json'), fingerprints)
  if (authText) {
    const auth = parseJsonc(authText)
    if (!record(auth) || Object.values(auth).some(value => value?.type === 'wellknown')) throw configError('暂不支持远程组织配置的凭据恢复')
  }
  return { config, fingerprint: JSON.stringify(fingerprints) }
}

function privateCommand(executable, args, context, subject = '配置') {
  const root = fs.mkdtempSync(path.join(context.temporaryRoot, 'insight-opencode-config-'))
  let fd
  try {
    fd = fs.openSync(path.join(root, 'output'), 'wx+', 0o600)
    const result = spawnSync(executable, args, {
      cwd: context.cwd, env: context.env, stdio: ['ignore', fd, 'pipe'], timeout: 15000, maxBuffer: LIMIT,
    })
    if (result.error || result.status !== 0) throw configError(`读取${subject}命令失败或超时`)
    if (fs.fstatSync(fd).size > LIMIT) throw configError('配置输出超过 8 MiB')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path.join(root, 'output'))) }
    catch { throw configError('配置输出不是有效 UTF-8') }
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd) }
    finally { fs.rmSync(root, { recursive: true, force: true }) }
  }
}

function assertLocalSources(executable, context) {
  const version = privateCommand(executable, ['--version'], context).trim()
  if (!['1.18.35', '1.19.3'].includes(version)) throw configError('当前 OpenCode 版本的脱敏配置恢复尚未验证')
  if (fs.existsSync(path.join(context.dataHome, 'opencode.db'))) {
    const query = 'SELECT count(*) AS active_orgs FROM account_state WHERE active_org_id IS NOT NULL'
    let rows
    try { rows = JSON.parse(privateCommand(executable, ['db', query, '--format', 'json'], context)) }
    catch { throw configError('无法确认 OpenCode 组织配置状态') }
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].active_orgs !== 0) throw configError('暂不支持远程账号组织配置的凭据恢复')
  }
}

function sensitive(value, key, headers) {
  if (headers || SECRET.test(key) || URL_FIELD.test(key)) return true
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false
  try {
    const url = new URL(value)
    return Boolean(url.username || url.password || [...url.searchParams.keys()].some(name => SECRET.test(name)))
  } catch { return true }
}

function restore(value, original, key = '', headers = false) {
  if (typeof value === 'string') {
    if (value !== '***') return value
    if (original === '***' && !sensitive(original, key, headers)) return value
    if (['prompt', 'description', 'name', 'system'].includes(key) && !headers) return value
    if (typeof original !== 'string' || !original.trim() || original === '***' || /\{(?:env|file):/.test(original)) {
      throw configError('无法恢复脱敏连接字段，请检查执行客户端的原始配置与引用')
    }
    return original
  }
  if (Array.isArray(value)) return value.map((item, i) => restore(item, original?.[i], key, headers))
  if (!record(value)) return value
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name,
    restore(item, record(original) ? original[name] : undefined, name, headers || name.toLowerCase() === 'headers')]))
}

function selectedModel(config, selection) {
  const agent = selection.agent || 'build'
  if (!['build', 'plan'].includes(agent) && !record(config.agent?.[agent])) throw configError('所选 Agent 的配置不存在')
  if (config.agent?.[agent]?.disable || config.agent?.[agent]?.mode === 'subagent') throw configError('所选 Agent 未启用或仅支持子 Agent 调用')
  const model = selection.model || config.agent?.[agent]?.model || config.model
  if (typeof model !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(model)) throw configError('请选择完整的 provider/model，或配置所选 Agent 的默认模型')
  return model
}

function connectionConfig(config, selection, modelOnly = false) {
  const agent = { ...(config.agent?.[selection.agent] || {}) }
  if (selection.model) delete agent.model
  delete agent.permission
  if (modelOnly) {
    const model = selectedModel(config, selection)
    const split = model.indexOf('/')
    const provider = model.slice(0, split), modelId = model.slice(split + 1)
    const selected = config.provider?.[provider]
    const providerConfig = selected && { ...selected, ...(selected.models ? {
      models: Object.hasOwn(selected.models, modelId) ? { [modelId]: selected.models[modelId] } : {},
    } : {}) }
    return { provider: providerConfig ? { [provider]: providerConfig } : {}, agent: { [selection.agent]: agent }, mcp: {} }
  }
  return { provider: config.provider || {}, agent: { [selection.agent]: agent }, mcp: selection.trigger ? {} : config.mcp || {} }
}

function hasMasked(value, key = '', headers = false) {
  if (typeof value === 'string') return value === '***' && (headers || !['prompt', 'description', 'name', 'system'].includes(key))
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([name, item]) => hasMasked(item, name, headers || name.toLowerCase() === 'headers'))
}

function parseOpenCodeConfigOutput(output) {
  const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  const fields = { provider: isRecord, agent: isRecord, mcp: isRecord,
    model: value => typeof value === 'string', small_model: value => typeof value === 'string',
    plugin: value => Array.isArray(value) && value.every(item => typeof item === 'string') }
  let config
  let end = 0
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < output.length; i++) {
    const char = output[i]
    if (start < 0) {
      if (char !== '{') continue
      start = i
      depth = 1
      continue
    }
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}') depth--
    if (depth !== 0) continue
    const fragment = output.slice(start, i + 1)
    start = -1
    let value
    try { value = JSON.parse(fragment) } catch { throw new Error('invalid JSON object') }
    if (!Object.keys(fields).some(key => Object.hasOwn(value, key))) continue
    if (config || Object.entries(fields).some(([key, validate]) => Object.hasOwn(value, key) && !validate(value[key]))) {
      throw new Error('ambiguous or invalid config')
    }
    config = value
    end = i + 1
  }
  if (!config || start >= 0 || output.slice(end).trim()) throw new Error('incomplete config output')
  return config
}


function readOpenCodeConfig(executable, options = {}) {
  return parseOpenCodeConfigOutput(privateCommand(executable, ['debug', 'config'], contextFor(options)))
}

function loadOpenCodeConnectionConfig(executable, selection, options = {}) {
  const context = contextFor(options)
  for (let attempt = 0; attempt < 2; attempt++) {
    let before, snapshotError
    try { before = snapshot(context) } catch (error) { snapshotError = error }
    let config
    try { config = readOpenCodeConfig(executable, context) }
    catch (error) {
      if (error.code === 'MODEL_UNAVAILABLE') throw error
      throw configError('OpenCode 配置无法解析，不允许使用默认模型替代')
    }
    const connections = connectionConfig(config, selection, options.modelOnly)
    if (!hasMasked(connections)) return { ...config, ...connections }
    if (snapshotError) throw snapshotError
    assertLocalSources(executable, context)
    const after = snapshot(context)
    if (before.fingerprint !== after.fingerprint || !isDeepStrictEqual(before.config, after.config)) {
      if (attempt === 0) continue
      throw configError('读取期间配置发生变化，请重试')
    }
    const original = connectionConfig(after.config, selection, options.modelOnly)
    // 同名连接仍可能指向不同端点，不能只凭名称拼接凭据。
    const check = (effective, candidate) => {
      if (effective === '***') return
      if ((record(effective) && record(candidate)) || (Array.isArray(effective) && Array.isArray(candidate))) {
        for (const [name, value] of Object.entries(candidate)) {
          if (Object.hasOwn(effective, name)) check(effective[name], value)
        }
      } else if (effective !== undefined && !isDeepStrictEqual(effective, candidate)) {
        throw configError('原始连接配置与 OpenCode 生效配置不一致')
      }
    }
    check(connections, original)
    return { ...config, ...restore(connections, original) }
  }
}

function assertNoMaskedConnections(config, selection) {
  if (hasMasked(connectionConfig(config, selection))) throw configError('不接受未恢复的脱敏连接配置')
}

function checkOpenCodeModelConfig(executable, selection, options = {}) {
  selection = { ...selection, agent: selection.agent || 'build' }
  const context = contextFor(options)
  const config = loadOpenCodeConnectionConfig(executable, selection, { ...options, modelOnly: true })
  const model = selectedModel(config, selection)
  const split = model.indexOf('/')
  const provider = model.slice(0, split)
  const providerConfig = config.provider?.[provider]
  if (config.disabled_providers?.includes(provider) || (config.enabled_providers && !config.enabled_providers.includes(provider))) {
    throw configError('所选 Provider 已被禁用或未包含在启用列表中')
  }
  const modelConfig = providerConfig?.models?.[model.slice(split + 1)]
  const connection = merge(providerConfig?.options || {}, modelConfig?.options || {})
  const nonempty = value => typeof value === 'string' && Boolean(value.trim()) && value !== '***' && !/\{(?:env|file):/.test(value)
  let local = false
  if (connection.baseURL !== undefined) {
    let endpoint
    try { if (nonempty(connection.baseURL)) endpoint = new URL(connection.baseURL) } catch {}
    if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
      throw configError('所选模型的 baseURL 无效，必须为已解析的 HTTP(S) 地址且不含用户密码或片段')
    }
    local = ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)
  }
  if (connection.apiKey !== undefined && !nonempty(connection.apiKey)) throw configError('所选模型的 API Key 为空、未解析或仍为脱敏占位符')
  const headers = { ...connection.headers, ...modelConfig?.headers }
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string' || /[\r\n]/.test(value) || value === '***' || /\{(?:env|file):/.test(value)
      || (SECRET.test(name) && (!value.trim() || /^(?:Bearer|Basic)\s*(?:\*+)?\s*$/i.test(value)))) {
      throw configError('所选模型的连接请求头包含无效值或未解析的凭据引用')
    }
  }
  let auth = {}
  const authFile = path.join(context.dataHome, 'auth.json')
  try {
    const content = context.env.OPENCODE_AUTH_CONTENT || (fs.existsSync(authFile) ? fs.readFileSync(authFile, 'utf8') : '')
    if (content) {
      const all = parseJsonc(content)
      if (!record(all)) throw new Error('invalid auth')
      auth = all[provider] || {}
    }
  } catch { throw configError('OpenCode 认证存储无法读取，请检查客户端运行账号和认证文件') }
  const authenticated = auth.type === 'oauth' ? nonempty(auth.refresh) || nonempty(auth.access)
    : auth.type === 'wellknown' ? nonempty(auth.key) && nonempty(auth.token) : nonempty(auth.key)
  if (Object.keys(auth).length && (!['api', 'oauth', 'wellknown'].includes(auth.type) || !authenticated)) throw configError('所选 Provider 的认证记录为空或不完整，请重新配置认证')
  const variables = [...(providerConfig?.env || []), `${provider.replace(/[^a-z0-9]/gi, '_').toUpperCase()}_API_KEY`]
  const credential = authenticated || nonempty(connection.apiKey) || variables.some(name => nonempty(context.env[name]))
    || Object.entries(headers).some(([name, value]) => SECRET.test(name) && nonempty(value))
  if (providerConfig && !credential && !local) throw configError('未找到所选模型的认证配置，请使用客户端运行账号配置 API Key、认证请求头或执行 opencode auth login')

  // 只读取原生模型目录，禁止目录刷新和自动升级，不执行 run 或推理请求。
  const catalog = privateCommand(executable, ['models'], { ...context, env: { ...context.env, OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_AUTOUPDATE: '1' } }, '模型目录')
  const models = catalog.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map(line => line.trim()).filter(line => /^[a-zA-Z0-9_.-]+\/[^\s]+$/.test(line))
  if (!models.includes(model)) throw configError(models.some(id => id.startsWith(`${provider}/`))
    ? '所选模型不在当前 OpenCode 模型目录中，请重新选择或修正模型配置'
    : '所选 Provider 未出现在当前 OpenCode 模型目录中，请检查 Provider 与认证配置')
  return { model }
}

function checkOpenCodeModelConfigAsync(executable, selection, { cwd, env, signal, temporaryRoot = os.tmpdir() } = {}) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    // 父进程持有目录，取消后也能清理被终止子进程的私有配置输出。
    const privateRoot = fs.mkdtempSync(path.join(temporaryRoot, 'insight-opencode-model-'))
    let child
    try {
      child = spawn(process.execPath, [__filename, '--check-model'], {
        cwd, env, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      })
    } catch {
      fs.rmSync(privateRoot, { recursive: true, force: true })
      reject(configError('无法启动模型配置检查进程')); return
    }
    let output = '', settled = false, stoppedError
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      try { fs.rmSync(privateRoot, { recursive: true, force: true }) }
      catch { error ||= configError('无法清理模型配置检查临时文件，请检查本机文件权限') }
      if (error) reject(error); else resolve(result)
    }
    const cancel = error => { stoppedError ||= error; stop() }
    const abort = () => cancel(signal.reason)
    const timer = setTimeout(() => cancel(configError('模型配置检查超时，请检查 CLI 与本机配置后重试')), 30000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.length > 65536) cancel(configError('模型配置检查输出异常'))
    })
    child.on('error', () => finish(configError('无法启动模型配置检查进程')))
    child.stdin.on('error', () => {})
    child.on('close', code => {
      if (stoppedError) return finish(stoppedError)
      let result
      try { result = JSON.parse(output) } catch { return finish(configError('模型配置检查中断或返回无效结果')) }
      if (result.error) return finish(Object.assign(new Error(result.error), { code: 'MODEL_UNAVAILABLE' }))
      if (code) return finish(configError('模型配置检查失败'))
      if (typeof result.model !== 'string') return finish(configError('模型配置检查未返回模型标识'))
      finish(null, result)
    })
    child.stdin.end(JSON.stringify({ executable, selection, temporaryRoot: privateRoot }))
    if (signal?.aborted) abort()
  })
}

module.exports = { loadOpenCodeConnectionConfig, assertNoMaskedConnections, readOpenCodeConfig, checkOpenCodeModelConfig, checkOpenCodeModelConfigAsync, parseJsonc }

if (require.main === module && process.argv[2] === '--check-model') {
  let input = ''
  process.stdin.on('data', chunk => { input += chunk })
  process.stdin.on('end', () => {
    try {
      const { executable, selection, temporaryRoot } = JSON.parse(input)
      process.stdout.write(JSON.stringify(checkOpenCodeModelConfig(executable, selection, { temporaryRoot })))
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: error.code === 'MODEL_UNAVAILABLE' ? error.message : '无法确认 OpenCode 模型配置，请检查客户端运行环境' }))
      process.exitCode = 1
    }
  })
}
