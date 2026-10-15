#!/usr/bin/env node
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

const CALL_HEADER = 'x-agent-insight-call-id'
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const text = value => typeof value === 'string' && value.length <= 512 ? value : undefined
const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

function forwardHeaders(source) {
  const excluded = new Set([...hopHeaders, ...String(source.connection || '').toLowerCase().split(',').map(s => s.trim())])
  return Object.fromEntries(Object.entries(source).filter(([key]) => !excluded.has(key.toLowerCase())))
}

function responseIdentity(contentType, protocol) {
  const decoder = new StringDecoder('utf8')
  const streaming = String(contentType).includes('text/event-stream')
  let buffer = '', invalid = false, id
  const accept = data => {
    try {
      const value = JSON.parse(data)
      const candidate = protocol === 'anthropic'
        ? (value.type === 'message_start' ? value.message?.id : value.type === 'message' ? value.id : undefined)
        : (value.response?.id || value.id)
      if (!text(candidate)) return
      if (id && id !== candidate) invalid = true
      id = candidate
    } catch {}
  }
  return {
    push(chunk) {
      if (invalid) return
      buffer += decoder.write(chunk)
      if (streaming) {
        let match
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          accept(frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
        }
      }
      if (buffer.length > 1024 * 1024) { invalid = true; buffer = '' }
    },
    finish() { buffer += decoder.end(); if (!streaming && !invalid) accept(buffer); return invalid ? undefined : id },
  }
}

export function createInferenceGateway(config, options = {}) {
  const env = options.env || process.env
  const insightDir = options.insightDir || env.AGENT_INSIGHT_HOME || path.join(os.homedir(), '.agent-insight')
  let installedKey
  for (const file of ['.env', 'config']) {
    try {
      const line = fs.readFileSync(path.join(insightDir, file), 'utf8').split(/\r?\n/).find(s => /^AGENT_INSIGHT_API_KEY=/.test(s.trim()))
      if (line) installedKey = line.trim().slice(line.trim().indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2')
    } catch {}
  }
  const account = hash((options.apiKey ?? env.AGENT_INSIGHT_API_KEY ?? installedKey) || 'anonymous').slice(0, 16)
  const timeoutMs = Number(config.timeoutMs ?? 300000)
  if (!(timeoutMs > 0 && Number.isFinite(timeoutMs))) throw new Error('Invalid timeoutMs')
  const compileRoutes = input => (input || []).map(route => {
    const upstream = new URL(route.upstreamBaseUrl)
    if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash) throw new Error('Invalid upstreamBaseUrl')
    if (!/^\/[a-zA-Z0-9/_-]+$/.test(route.basePath) || route.basePath.endsWith('/') || route.basePath.includes('//')) throw new Error('Invalid basePath')
    if (!['qoder', 'opencode'].includes(route.agent) || !['openai', 'anthropic'].includes(route.protocol)) throw new Error('Invalid agent or protocol')
    let auth
    if (route.apiKeyEnv) {
      if (!env[route.apiKeyEnv]) throw new Error(`Missing upstream credential environment variable: ${route.apiKeyEnv}`)
      auth = route.protocol === 'anthropic' ? ['x-api-key', env[route.apiKeyEnv]] : ['authorization', `Bearer ${env[route.apiKeyEnv]}`]
    }
    return { ...route, upstream, auth }
  }).sort((a, b) => b.basePath.length - a.basePath.length)
  let routes = compileRoutes(config.routes)
  if ((!routes.length && !options.getRoutes) || new Set(routes.map(r => r.basePath)).size !== routes.length) throw new Error('Configure unique gateway routes')
  return http.createServer((req, res) => {
    if (options.getRoutes) {
      try { routes = compileRoutes(options.getRoutes()) } catch { res.writeHead(503); res.end(); req.resume(); return }
    }
    const pathname = String(req.url || '').split('?')[0]
    const route = routes.find(r => pathname.startsWith(r.basePath + '/'))
    const suffix = route ? pathname.slice(route.basePath.length) : ''
    const modelCall = req.method === 'POST' && (route?.protocol === 'anthropic' ? suffix === '/messages' : ['/chat/completions', '/responses'].includes(suffix))
    if (!route || (!modelCall && !(req.method === 'GET' && suffix === '/models'))) { res.writeHead(404); res.end(); req.resume(); return }
    const callId = modelCall ? crypto.randomUUID() : undefined
    const record = {
      version: 1, call_id: callId, agent: route.agent, protocol: route.protocol,
      session_id: text(req.headers[route.agent === 'qoder' ? 'session-id' : 'x-agent-insight-session-id']),
      message_id: text(req.headers['x-agent-insight-message-id']), request_id: text(req.headers['x-agent-insight-request-id']),
      attempt_id: text(req.headers['x-agent-insight-attempt-id']), started_at: new Date().toISOString(), state: 'started',
    }
    const recordDir = path.join(insightDir, 'inference-gateway', account, route.agent, hash(record.session_id || '__unbound__'))
    const persist = () => {
      if (!modelCall) return
      fs.mkdirSync(recordDir, { recursive: true, mode: 0o700 })
      const file = path.join(recordDir, `${callId}.json`)
      const temp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 })
      fs.renameSync(temp, file)
      const marker = path.join(insightDir, 'inference-gateway', account, route.agent, 'updated')
      fs.writeFileSync(`${marker}.${process.pid}.tmp`, crypto.randomUUID(), { mode: 0o600 })
      fs.renameSync(`${marker}.${process.pid}.tmp`, marker)
    }
    try { persist() } catch { res.writeHead(503); res.end('{"error":{"message":"Correlation storage unavailable"}}'); req.resume(); return }
    const headers = forwardHeaders(req.headers)
    delete headers.host
    for (const key of Object.keys(headers)) if (key.startsWith('x-agent-insight-') || ['session-id', 'x-session-id', 'x-parent-session-id'].includes(key)) delete headers[key]
    headers['accept-encoding'] = 'identity'
    if (callId) headers[CALL_HEADER] = callId
    if (route.auth) { delete headers.authorization; delete headers['x-api-key']; headers[route.auth[0]] = route.auth[1] }
    const upstream = new URL(route.upstream)
    upstream.pathname = upstream.pathname.replace(/\/$/, '') + suffix
    upstream.search = new URL(req.url, 'http://localhost').search
    let finished = false, parser, responseStream
    const finish = (state, errorType) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      Object.assign(record, { state, completed_at: new Date().toISOString(), ...(errorType ? { error_type: errorType } : {}) })
      if (record.status_code >= 200 && record.status_code < 300 && parser) record.response_id = parser.finish()
      persist()
    }
    const fail = (state, code) => {
      try { finish(state, state) } catch { res.destroy(); return }
      if (!res.headersSent) { res.writeHead(code, { 'content-type': 'application/json', ...(callId ? { [CALL_HEADER]: callId } : {}) }); res.end(JSON.stringify({ error: { message: 'Inference upstream unavailable', type: state } })) }
      else res.destroy()
    }
    const out = (upstream.protocol === 'https:' ? https : http).request(upstream, { method: req.method, headers }, incoming => {
      responseStream = incoming
      record.status_code = incoming.statusCode
      parser = responseIdentity(incoming.headers['content-type'], route.protocol)
      const responseHeaders = forwardHeaders(incoming.headers)
      if (callId) responseHeaders[CALL_HEADER] = callId
      // Withhold redirects: following one would bypass the fixed upstream and its call ID.
      delete responseHeaders.location
      res.writeHead(incoming.statusCode, responseHeaders)
      incoming.on('data', chunk => parser.push(chunk))
      incoming.on('end', () => { try { finish('completed'); res.end() } catch { res.destroy() } })
      incoming.on('error', () => fail('stream_error', 502))
      incoming.pipe(res, { end: false })
    })
    const timer = setTimeout(() => { fail('timeout', 504); out.destroy(); responseStream?.destroy() }, timeoutMs)
    out.on('error', () => fail('transport_error', 502))
    const cancel = () => {
      if (finished) return
      try { finish('cancelled') } catch {}
      out.destroy(); responseStream?.destroy()
    }
    req.on('aborted', cancel)
    req.on('error', cancel)
    res.on('close', cancel)
    req.pipe(out)
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const file = process.argv[2]
    if (!file) throw new Error('Usage: node scripts/inference_gateway.mjs <config.json>')
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    const host = config.host || '127.0.0.1'
    if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Local gateway must listen on loopback')
    const server = createInferenceGateway(config)
    server.on('error', () => { process.stderr.write('Inference gateway listen failed\n'); process.exitCode = 1 })
    server.listen(config.port ?? 18080, host, () => process.stdout.write(`Inference gateway listening on ${host}:${server.address().port}\n`))
    const stop = () => { server.close(); server.closeAllConnections() }
    process.once('SIGINT', stop); process.once('SIGTERM', stop)
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
