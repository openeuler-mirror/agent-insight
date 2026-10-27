const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
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
  const home = options.home || os.homedir()
  const cwd = fs.realpathSync(options.cwd || process.cwd())
  const configHome = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
  const dataHome = path.join(env.XDG_DATA_HOME || path.join(home, '.local/share'), 'opencode')
  return { env, home, cwd, configHome, dataHome, platform: options.platform || process.platform }
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

function privateCommand(executable, args, context) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'insight-opencode-config-'))
  let fd
  try {
    fd = fs.openSync(path.join(root, 'output'), 'wx+', 0o600)
    const result = spawnSync(executable, args, {
      cwd: context.cwd, env: context.env, stdio: ['ignore', fd, 'pipe'], timeout: 15000, maxBuffer: LIMIT,
    })
    if (result.error || result.status !== 0) throw configError('读取配置命令失败或超时')
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

function connectionConfig(config, selection) {
  const agent = { ...(config.agent?.[selection.agent] || {}) }
  if (selection.model) delete agent.model
  delete agent.permission
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
    const connections = connectionConfig(config, selection)
    if (!hasMasked(connections)) return { ...config, ...connections }
    if (snapshotError) throw snapshotError
    assertLocalSources(executable, context)
    const after = snapshot(context)
    if (before.fingerprint !== after.fingerprint || !isDeepStrictEqual(before.config, after.config)) {
      if (attempt === 0) continue
      throw configError('读取期间配置发生变化，请重试')
    }
    const original = connectionConfig(after.config, selection)
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

module.exports = { loadOpenCodeConnectionConfig, assertNoMaskedConnections, readOpenCodeConfig, parseJsonc }
