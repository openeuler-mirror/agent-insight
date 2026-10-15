import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function parseConfig(source, file) {
  let at = source.charCodeAt(0) === 0xfeff ? 1 : 0
  const strings = new Map()
  const invalid = () => { throw new Error(`Invalid JSON/JSONC configuration: ${file} at ${at}`) }
  const skip = () => {
    while (at < source.length) {
      if (/\s/.test(source[at])) { at++; continue }
      if (source.slice(at, at + 2) === '//') {
        while (at < source.length && source[at] !== '\n') at++
      } else if (source.slice(at, at + 2) === '/*') {
        const end = source.indexOf('*/', at + 2)
        if (end < 0) invalid()
        at = end + 2
      } else break
    }
  }
  const string = () => {
    const start = at++
    while (at < source.length) {
      const char = source[at++]
      if (char === '\\') { at++; continue }
      if (char === '"') {
        try { return { start, end: at, value: JSON.parse(source.slice(start, at)) } } catch { invalid() }
      }
    }
    invalid()
  }
  const value = (field, depth = 0) => {
    if (depth > 128) invalid()
    skip()
    if (source[at] === '"') {
      const token = string()
      strings.set(JSON.stringify(field), token)
      return token.value
    }
    if (source[at] === '{' || source[at] === '[') {
      const isObject = source[at++] === '{'
      const end = isObject ? '}' : ']'
      const result = isObject ? Object.create(null) : []
      skip()
      if (source[at] === end) { at++; return result }
      while (at < source.length) {
        let key = result.length
        if (isObject) {
          if (source[at] !== '"') invalid()
          key = string().value
          if (Object.hasOwn(result, key)) throw new Error(`Duplicate JSON key in configuration: ${file}`)
          skip()
          if (source[at++] !== ':') invalid()
        }
        result[key] = value([...field, key], depth + 1)
        skip()
        if (source[at] === end) { at++; return result }
        if (source[at++] !== ',') invalid()
        skip()
        if (source[at] === end) { at++; return result }
      }
      invalid()
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(source.slice(at))
    if (!literal) invalid()
    at += literal[0].length
    return JSON.parse(literal[0])
  }
  const data = value([])
  skip()
  if (at !== source.length || !object(data)) invalid()
  return { data, strings }
}

function stateLocation(insightDir) {
  return path.join(path.resolve(insightDir), 'inference-proxy', 'config-state.json')
}

function loadState(file) {
  if (!fs.existsSync(file)) return { version: 1, files: {}, routes: [] }
  let state
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { throw new Error('Invalid inference configuration state') }
  if (state?.version !== 1 || !object(state.files) || !Array.isArray(state.routes)) throw new Error('Invalid inference configuration state')
  return state
}

function atomicWrite(file, bytes, mode, expected) {
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    const fd = fs.openSync(temporary, 'wx', mode)
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    if (expected && !fs.readFileSync(file).equals(expected)) throw new Error(`Configuration changed concurrently: ${file}`)
    fs.renameSync(temporary, file)
  } finally {
    try { fs.unlinkSync(temporary) } catch {}
  }
}

function readConfig(file) {
  const resolved = fs.realpathSync(path.resolve(file))
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error(`Configuration is not a regular file: ${file}`)
  const bytes = fs.readFileSync(resolved)
  const source = bytes.toString('utf8')
  if (!Buffer.from(source).equals(bytes)) throw new Error(`Invalid UTF-8 configuration: ${file}`)
  return { file: resolved, bytes, source, mode: stat.mode & 0o777, ...parseConfig(source, resolved) }
}

function replaceTokens(document, replacements) {
  let source = document.source
  for (const { token, replacement } of replacements.sort((a, b) => b.token.start - a.token.start)) {
    source = source.slice(0, token.start) + replacement + source.slice(token.end)
  }
  return Buffer.from(source)
}

function verifyBackup(root, entry) {
  if (typeof entry.backup !== 'string' || path.basename(entry.backup) !== entry.backup) throw new Error('Invalid inference backup path')
  const file = path.join(root, 'backups', entry.backup)
  if (!fs.lstatSync(file).isFile()) throw new Error('Invalid inference backup file')
  const bytes = fs.readFileSync(file)
  if (digest(bytes) !== entry.backupHash) throw new Error('Inference backup hash integrity check failed')
  return bytes
}

function commit(stateFile, state, changes, newBackups) {
  for (const item of changes) {
    if (!fs.readFileSync(item.file).equals(item.bytes)) throw new Error(`Configuration changed concurrently: ${item.file}`)
  }
  const root = path.dirname(stateFile)
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true, mode: 0o700 })
  for (const { entry, bytes } of newBackups) {
    const backup = path.join(root, 'backups', entry.backup)
    const temporary = `${backup}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      const fd = fs.openSync(temporary, 'wx', 0o600)
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      fs.linkSync(temporary, backup)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    } finally {
      try { fs.unlinkSync(temporary) } catch {}
    }
    if (!fs.lstatSync(backup).isFile()) throw new Error('Invalid inference backup file')
    fs.chmodSync(backup, 0o600)
    entry.backupHash = digest(fs.readFileSync(backup))
  }
  // Save field ownership before rewriting Agent files so an interrupted install remains recoverable.
  atomicWrite(stateFile, Buffer.from(JSON.stringify(state, null, 2) + '\n'), 0o600)
  const written = []
  try {
    for (const item of changes) {
      atomicWrite(item.file, item.next, item.mode, item.bytes)
      written.push(item)
    }
  } catch (error) {
    for (const item of written.reverse()) {
      try { atomicWrite(item.file, item.bytes, item.mode, item.next) } catch {}
    }
    throw error
  }
}

function candidates(document, agent) {
  const providers = agent === 'qoder' ? document.data.providers : document.data.provider
  if (providers === undefined) return []
  if (!object(providers)) throw new Error(`Invalid provider object in configuration: ${document.file}`)
  return Object.entries(providers).map(([id, provider]) => {
    const field = agent === 'qoder' ? ['providers', id, 'baseUrl'] : ['provider', id, 'options', 'baseURL']
    let protocol
    if (agent === 'qoder') {
      if (provider?.type === 'openai-compatible' && (!provider.protocol || provider.protocol === 'openai')) protocol = 'openai'
      if (provider?.type === 'anthropic-compatible' && (!provider.protocol || provider.protocol === 'anthropic')) protocol = 'anthropic'
    } else {
      if (['@ai-sdk/openai-compatible', '@ai-sdk/openai'].includes(provider?.npm)) protocol = 'openai'
      if (provider?.npm === '@ai-sdk/anthropic') protocol = 'anthropic'
    }
    return { field, protocol, token: document.strings.get(JSON.stringify(field)) }
  })
}

function upstreamAddress(raw, env) {
  const variable = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(raw)
  const address = variable ? env[variable[1]] : raw
  if (typeof address !== 'string' || !address.trim()) return { reason: 'missing_environment_variable' }
  let url
  try { url = new URL(address) } catch { return { reason: 'invalid_upstream' } }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return { reason: 'invalid_upstream' }
  if (/^\/managed\/(?:opencode|qoder)(?:\/|$)/.test(url.pathname)) return { reason: 'unknown_managed_endpoint' }
  return { resolved: url.href.replace(/\/$/, '') }
}

export function syncConfigFiles({ insightDir, origin, files, env = process.env }) {
  const gateway = new URL(origin)
  if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.hash || gateway.pathname !== '/') throw new Error('Invalid inference gateway origin')
  const stateFile = stateLocation(insightDir)
  const state = loadState(stateFile)
  const changes = [], unsupported = [], newBackups = []
  const documents = [], seen = new Set()
  for (const item of files) {
    if (!['qoder', 'opencode'].includes(item.agent)) throw new Error('Unsupported Agent configuration type')
    if (!fs.existsSync(item.file)) { unsupported.push({ ...item, reason: 'missing_file' }); continue }
    const document = { ...readConfig(item.file), agent: item.agent }
    if (seen.has(document.file)) throw new Error(`Duplicate configuration file: ${document.file}`)
    seen.add(document.file)
    documents.push(document)
  }
  for (const document of documents) {
    const existing = state.files[document.file]
    if (existing && existing.agent !== document.agent) throw new Error('Configuration Agent ownership mismatch')
    if (existing) verifyBackup(path.dirname(stateFile), existing)
    const entry = existing || { agent: document.agent, backup: digest(document.file) + '.bak', backupHash: digest(document.bytes), fields: {} }
    const replacements = []
    for (const candidate of candidates(document, document.agent)) {
      const { field, protocol, token } = candidate
      const reject = reason => unsupported.push({ agent: document.agent, file: document.file, field, reason })
      if (!protocol) { reject('unsupported_provider'); continue }
      if (!token) { reject('missing_explicit_endpoint'); continue }
      const key = JSON.stringify(field)
      const prior = entry.fields[key]
      const owned = prior && [prior, ...(prior.aliases || [])].find(record => record.managed === token.value)
      const original = owned ? owned.original : token.value
      const originalToken = owned ? owned.originalToken : document.source.slice(token.start, token.end)
      const upstream = upstreamAddress(original, env)
      if (upstream.reason) { reject(upstream.reason); continue }
      const basePath = `/managed/${document.agent}/${digest(JSON.stringify([document.file, field, upstream.resolved, protocol])).slice(0, 24)}`
      const route = { basePath, agent: document.agent, protocol, upstreamBaseUrl: upstream.resolved }
      const known = state.routes.find(route => route.basePath === basePath)
      if (known && JSON.stringify(known) !== JSON.stringify(route)) throw new Error('Conflicting managed inference route')
      if (!known) state.routes.push(route)
      const managed = gateway.origin + basePath
      const aliases = [...(prior?.aliases || [])]
      if (prior && prior.managed !== managed && !aliases.some(alias => alias.managed === prior.managed)) {
        aliases.push({ original: prior.original, originalToken: prior.originalToken, managed: prior.managed })
      }
      entry.fields[key] = { field, original, originalToken, managed, aliases }
      if (token.value !== managed) replacements.push({ token, replacement: JSON.stringify(managed) })
    }
    if (Object.keys(entry.fields).length) {
      state.files[document.file] = entry
      if (!existing) newBackups.push({ entry, bytes: document.bytes })
    }
    if (replacements.length) changes.push({ ...document, next: replaceTokens(document, replacements) })
  }
  if (Object.keys(state.files).length || state.routes.length) commit(stateFile, state, changes, newBackups)
  return { routes: state.routes, changed: changes.map(item => item.file), unsupported }
}

export function restoreConfigFiles({ insightDir }) {
  const stateFile = stateLocation(insightDir)
  const state = loadState(stateFile)
  const changes = [], unsupported = []
  for (const [file, entry] of Object.entries(state.files)) {
    verifyBackup(path.dirname(stateFile), entry)
    if (!fs.existsSync(file)) { unsupported.push({ file, agent: entry.agent, reason: 'missing_file' }); continue }
    const document = readConfig(file)
    const replacements = []
    for (const [key, field] of Object.entries(entry.fields)) {
      const token = document.strings.get(key)
      const owned = token && [field, ...(field.aliases || [])].find(record => record.managed === token.value)
      if (owned) replacements.push({ token, replacement: owned.originalToken || JSON.stringify(owned.original) })
    }
    if (replacements.length) changes.push({ ...document, next: replaceTokens(document, replacements) })
  }
  if (changes.length) commit(stateFile, state, changes, [])
  return { routes: state.routes, changed: changes.map(item => item.file), unsupported }
}
