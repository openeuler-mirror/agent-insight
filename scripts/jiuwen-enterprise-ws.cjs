/* Copyright (c) 2026 Huawei Technologies Co., Ltd. SPDX-License-Identifier: Apache-2.0 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { getAgentInsightHome } = require('./agent-insight-home.cjs')
const { connectWebSocket } = require('./ws-client.cjs')
const failure = (code, message) => Object.assign(new Error(message), { code })
const unavailable = reason => ({ enterprise: true, ready: false, canResolveTraceId: false, agents: [], models: [], agentCatalog: [], reason })
const safeString = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value)

function createEnterpriseWs(options = {}) {
  const configFile = () => options.configFile || process.env.AGENT_INSIGHT_JIUWEN_ENTERPRISE_CONFIG || path.join(getAgentInsightHome(), 'client', 'jiuwen-enterprise.json')
  let state, fingerprint, capability, discoveredAt = 0, enabled = false
  const configured = () => { enabled ||= Boolean(options.configFile || process.env.AGENT_INSIGHT_JIUWEN_ENTERPRISE_CONFIG || fs.existsSync(configFile())); return enabled }
  const readConfig = () => {
    try {
      const stat = fs.lstatSync(configFile())
      if (!stat.isFile() || stat.size > 64 * 1024 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error()
      const raw = fs.readFileSync(configFile(), 'utf8')
      const next = createHash('sha256').update(raw).digest('hex')
      if (next === fingerprint) return state
      capability = undefined; discoveredAt = 0
      const config = JSON.parse(raw), url = new URL(config.baseUrl)
      if (!safeString(config.username) || typeof config.password !== 'string' || !config.password || config.password.length > 8192
        || url.username || url.password || url.search || url.hash || url.pathname !== '/'
        || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error()
      state = { identity: { baseUrl: url.origin, username: config.username, password: config.password }, tokens: null, authInFlight: null }
      fingerprint = next
      return state
    } catch {
      state = null; fingerprint = null
      throw failure('JIUWEN_CONFIG_INVALID', '企业账号文件无效；请配置 baseUrl、username、password，使用 HTTPS，Unix 文件权限设为 600')
    }
  }
  const assertCurrent = snapshot => {
    if (readConfig() !== snapshot) throw failure('JIUWEN_CONFIG_CHANGED', '企业账号配置已变化，本次旧身份请求已停止，请重新操作')
  }
  const request = async (snapshot, endpoint, init = {}) => {
    let response
    try { response = await fetch(snapshot.identity.baseUrl + endpoint, { ...init, redirect: 'error', signal: init.signal || AbortSignal.timeout(15_000) }) }
    catch { throw failure('JIUWEN_CONNECTION_FAILED', '企业入口连接失败，请检查地址、网络及可信 CA') }
    return response
  }
  const json = async response => {
    if (!response.ok) {
      await response.body?.cancel()
      throw failure(response.status === 401 ? 'JIUWEN_AUTH_REQUIRED' : response.status === 403 ? 'JIUWEN_ACCESS_DENIED' : 'JIUWEN_HTTP_ERROR', `企业接口返回 HTTP ${response.status}，请检查账号和权限`)
    }
    let chunks = [], bytes = 0
    for await (const chunk of response.body || []) {
      bytes += chunk.length
      if (bytes > 2 * 1024 * 1024) throw failure('JIUWEN_RESPONSE_INVALID', '企业接口响应过大')
      chunks.push(Buffer.from(chunk))
    }
    let body
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure('JIUWEN_RESPONSE_INVALID', '企业接口未返回有效 JSON') }
    if (body.ok === false || (typeof body.code === 'number' && ![0, 200].includes(body.code))) throw failure('JIUWEN_REQUEST_FAILED', '企业接口拒绝请求，请检查账号权限')
    return body
  }
  const authenticate = async (snapshot, force = false) => {
    if (!force && snapshot.tokens && snapshot.tokens.expiresAt > Date.now() + 15_000) return
    if (snapshot.authInFlight) return snapshot.authInFlight
    snapshot.authInFlight = (async () => {
      let body
      if (snapshot.tokens?.refresh_token) {
        const response = await request(snapshot, '/idp/v1/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: snapshot.tokens.refresh_token }) })
        if (response.status === 401 || response.status === 403) { await response.body?.cancel(); snapshot.tokens = null }
        else body = await json(response)
      }
      if (!body) body = await json(await request(snapshot, '/idp/v1/auth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: snapshot.identity.username, password: snapshot.identity.password }).toString() }))
      if (![body.access_token, body.refresh_token].every(v => typeof v === 'string' && v.length > 0 && v.length <= 16384 && !/[\x00-\x20\x7f]/.test(v))) throw failure('JIUWEN_AUTH_REQUIRED', '企业登录响应缺少有效凭证')
      assertCurrent(snapshot)
      snapshot.tokens = { access_token: body.access_token, refresh_token: body.refresh_token, expiresAt: Date.now() + Math.max(1, Number(body.expires_in) || 1800) * 1000 }
    })().finally(() => { snapshot.authInFlight = null })
    return snapshot.authInFlight
  }
  const contexts = async (snapshot) => {
    assertCurrent(snapshot); await authenticate(snapshot)
    assertCurrent(snapshot)
    const init = () => ({ headers: { authorization: `Bearer ${snapshot.tokens.access_token}` } })
    let response = await request(snapshot, '/api/v1/user-console/agent-contexts', init())
    if (response.status === 401) { await response.body?.cancel(); await authenticate(snapshot, true); assertCurrent(snapshot); response = await request(snapshot, '/api/v1/user-console/agent-contexts', init()) }
    const body = await json(response)
    if (!Array.isArray(body.data?.contexts) || body.data.contexts.length > 500) throw failure('JIUWEN_RESPONSE_INVALID', '企业接口未返回有效授权 Agent 列表')
    assertCurrent(snapshot)
    const rows = body.data.contexts
    if (rows.some(c => !c || !['user_id', 'group_id', 'bot_id', 'jiuwenclaw_id'].every(k => safeString(c[k])))) throw failure('JIUWEN_RESPONSE_INVALID', '企业 Agent 授权上下文无效')
    return { rows, snapshot }
  }
  const key = (c, snapshot) => 'jiuwen-ee-' + createHash('sha256').update(JSON.stringify([snapshot.identity.baseUrl, c.user_id, c.jiuwenclaw_id, c.group_id, c.bot_id])).digest('hex').slice(0, 32)
  const target = (c, snapshot) => {
    assertCurrent(snapshot)
    const url = new URL('/ws', snapshot.identity.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    for (const field of ['user_id', 'group_id', 'bot_id']) url.searchParams.set(field, c[field])
    return { url: url.href, headers: { authorization: `Bearer ${snapshot.tokens.access_token}`, cookie: `openjiuwen_access_token=${encodeURIComponent(snapshot.tokens.access_token)}; jiuwenclaw_id=${encodeURIComponent(c.jiuwenclaw_id)}` } }
  }
  const catalog = async destination => {
    const conn = await connectWebSocket(destination.url, { headers: destination.headers, handshakeTimeoutMs: 8000 })
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value, error) => { if (settled) return; settled = true; clearTimeout(timer); conn.close(); error ? reject(error) : resolve(value) }
      const timer = setTimeout(() => finish(null, failure('JIUWEN_GATEWAY_UNAVAILABLE', '目标 Agent 模型目录超时')), 8000)
      conn.on('close', () => finish(null, failure('JIUWEN_GATEWAY_UNAVAILABLE', '目标 Agent 连接提前关闭')))
      conn.on('message', raw => {
        let x; try { x = JSON.parse(raw) } catch { return }
        if (x.id !== 'catalog') return
        if (!x.ok || !Array.isArray(x.payload?.models)) { finish(null, failure('JIUWEN_MODEL_UNAVAILABLE', '目标 Agent 模型目录不可用')); return }
        const names = x.payload.models.map(m => m.model_name).filter(safeString)
        finish({ models: [...new Set(names)].filter(n => names.filter(v => v === n).length === 1), activeModel: x.payload.active_model || '' })
      })
      conn.send(JSON.stringify({ type: 'req', id: 'catalog', method: 'models.list', params: {} }))
    })
  }
  const clear = e => { capability = unavailable(e.message); discoveredAt = Date.now() }
  const refresh = async () => {
    if (!configured()) { capability = undefined; return null }
    let snapshot
    try {
      snapshot = readConfig()
      const { rows } = await contexts(snapshot)
      const entries = []
      // Bound concurrent connections even when the account has many authorized Agents.
      for (let start = 0; start < rows.length; start += 4) {
        entries.push(...await Promise.all(rows.slice(start, start + 4).map(async c => {
          const entry = { id: key(c, snapshot), label: `${c.agent_name || 'Agent'} · ${c.jiuwenclaw_name || c.jiuwenclaw_id} · ${c.group_name || c.group_id}`, models: [], ready: false }
          try { const found = await catalog(target(c, snapshot)); entry.models = found.models; entry.ready = found.models.length > 0; if (!entry.ready) entry.unavailableReason = '目标 Agent 没有可用模型' }
          catch { entry.unavailableReason = '目标 Agent WebSocket 或模型目录不可用' }
          return entry
        })))
      }
      assertCurrent(snapshot)
      const agentCatalog = [...new Map(entries.map(e => [e.id, e])).values()]
      const counts = new Map()
      for (const item of agentCatalog) counts.set(item.label, (counts.get(item.label) || 0) + 1)
      for (const item of agentCatalog) if (counts.get(item.label) > 1) item.label += ` · ${item.id.slice(-8)}`
      capability = { enterprise: true, ready: agentCatalog.some(e => e.ready), canResolveTraceId: true, agents: agentCatalog.map(e => e.id), models: [], agentCatalog,
        reason: !agentCatalog.length ? '账号没有授权 Agent，请在 JiuwenSwarm 管理面授予使用权限' : agentCatalog.every(e => !e.ready) ? '所有授权 Agent 的模型或 WebSocket 均未就绪' : undefined }
      discoveredAt = Date.now()
      return capability
    } catch (e) { if (snapshot) assertCurrent(snapshot); clear(e); throw e }
  }
  const probe = () => {
    if (!configured()) return null
    try { readConfig() } catch (e) { clear(e) }
    return capability && Date.now() - discoveredAt < 90_000 ? capability : unavailable('企业授权发现尚未完成或已过期，请检查账号配置并刷新客户端能力')
  }
  const resolve = async id => {
    let snapshot
    try {
      snapshot = readConfig()
      const { rows } = await contexts(snapshot)
      const c = rows.find(c => key(c, snapshot) === id)
      if (!c) { capability = unavailable('目标 Agent 已不在当前账号授权范围，请刷新后重新选择'); discoveredAt = Date.now(); throw failure('JIUWEN_CONTEXT_UNAVAILABLE', '目标 Agent 不在当前账号授权范围，请刷新并重新选择，不会回退其他 Agent') }
      return target(c, snapshot)
    } catch (e) { if (snapshot) assertCurrent(snapshot); clear(e); throw e }
  }
  return { configured, refresh, probe, resolve }
}

function authorizedSocket(destination) {
  class Socket extends EventTarget {
    constructor() {
      super(); this.readyState = 0
      connectWebSocket(destination.url, { headers: destination.headers, handshakeTimeoutMs: 8000 }).then(conn => {
        if (this.readyState === 3) { conn.close(); return }
        this.conn = conn; this.readyState = 1
        conn.on('message', data => this.dispatchEvent(new MessageEvent('message', { data })))
        conn.on('close', () => { this.readyState = 3; this.dispatchEvent(new Event('close')) })
        this.dispatchEvent(new Event('open'))
      }).catch(() => { this.readyState = 3; this.dispatchEvent(new Event('error')); this.dispatchEvent(new Event('close')) })
    }
    send(raw) { return this.conn?.send(raw) }
    close() { this.readyState = 3; this.conn?.close() }
  }
  return new Socket()
}
const enterpriseWs = createEnterpriseWs()
module.exports = { createEnterpriseWs, enterpriseWs, authorizedSocket }
if (require.main === module) enterpriseWs.refresh().then(cap => {
  if (!cap) throw failure('JIUWEN_CONFIG_INVALID', '未找到企业账号配置文件')
  if (!cap.ready) throw failure('JIUWEN_CONTEXT_UNAVAILABLE', cap.reason)
  console.log(`企业登录成功：发现 ${cap.agents.length} 个授权 Agent，${cap.agentCatalog.filter(a => a.ready).length} 个已就绪；实验页可直接选择，无需填写 bot_id`)
}).catch(e => { console.error(`${e.code || 'JIUWEN_ENTERPRISE_FAILED'}: ${e.message}`); process.exitCode = 1 })
