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

function commit(stateFile, state, changes) {
  for (const item of changes) {
    if (!fs.readFileSync(item.file).equals(item.bytes)) throw new Error(`Configuration changed concurrently: ${item.file}`)
  }
  const root = path.dirname(stateFile)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  // Publish routes first so any successfully rewritten file already has a live upstream mapping.
  atomicWrite(stateFile, Buffer.from(JSON.stringify(state, null, 2) + '\n'), 0o600)
  for (const item of changes) {
    atomicWrite(item.file, item.next, item.mode, item.bytes)
  }
}

function candidates(document, agent) {
  const groups = agent === 'qoder' ? ['providers'] : ['provider', 'providers']
  return groups.flatMap(group => {
    const providers = document.data[group]
    if (providers === undefined) return []
    if (!object(providers)) throw new Error(`Invalid provider object in configuration: ${document.file}`)
    return Object.entries(providers).map(([id, provider]) => {
      const native = agent === 'opencode' && group === 'providers'
      const field = agent === 'qoder' ? [group, id, 'baseUrl'] : [group, id, native ? 'settings' : 'options', 'baseURL']
      let protocol
      if (agent === 'qoder') {
        if (provider?.type === 'openai-compatible' && (!provider.protocol || provider.protocol === 'openai')) protocol = 'openai'
        if (provider?.type === 'anthropic-compatible' && (!provider.protocol || provider.protocol === 'anthropic')) protocol = 'anthropic'
      } else {
        const pkg = native ? provider?.package?.replace(/^aisdk:/, '') : provider?.npm
        if (['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@opencode/ai/providers/openai-compatible', '@opencode/ai/providers/openai'].includes(pkg) || (native && !pkg && id === 'openai')) protocol = 'openai'
        if (['@ai-sdk/anthropic', '@opencode/ai/providers/anthropic'].includes(pkg) || (native && !pkg && id === 'anthropic')) protocol = 'anthropic'
      }
      return { field, protocol, token: document.strings.get(JSON.stringify(field)) }
    })
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
  const changes = [], unsupported = [], managedEndpoints = []
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
    const entry = { agent: document.agent, fields: existing?.fields || {} }
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
        aliases.push({ original: prior.original, managed: prior.managed })
      }
      entry.fields[key] = { field, original, managed, aliases: aliases.map(({ original, managed }) => ({ original, managed })) }
      managedEndpoints.push({ agent: document.agent, file: document.file, field })
      if (token.value !== managed) replacements.push({ token, replacement: JSON.stringify(managed) })
    }
    if (Object.keys(entry.fields).length) {
      state.files[document.file] = entry
    }
    if (replacements.length) changes.push({ ...document, next: replaceTokens(document, replacements) })
  }
  if (Object.keys(state.files).length || state.routes.length) commit(stateFile, state, changes)
  return { routes: state.routes, changed: changes.map(item => item.file), unsupported, managed: managedEndpoints }
}
