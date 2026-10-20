'use strict'

const error = (code, message) => Object.assign(new Error(message), { code })

class XGovernorClient {
  constructor(baseUrl, auth, fetchImpl = fetch) { this.baseUrl = baseUrl; this.auth = auth; this.fetch = fetchImpl }
  async request(route, body, signal, timeoutMs = 30000) {
    let response
    try {
      response = await this.fetch(`${this.baseUrl}/api/v1${route}`, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.auth}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      })
    } catch (cause) {
      if (signal?.aborted) throw signal.reason
      throw error('XGOVERNOR_UNAVAILABLE', `xGovernor 请求未确认完成 (${cause.name || 'transport'})`)
    }
    if (!response.ok) { await response.body?.cancel(); throw error('XGOVERNOR_REJECTED', `xGovernor ${route} 返回 HTTP ${response.status}`) }
    const content = await response.text()
    return content ? JSON.parse(content) : null
  }
  async events(runtimeId, turnId, signal, onEvent) {
    const response = await this.fetch(`${this.baseUrl}/api/v1/sessions/${encodeURIComponent(runtimeId)}/turns/${encodeURIComponent(turnId)}/events`, {
      headers: { authorization: `Bearer ${this.auth}` }, redirect: 'error', signal,
    })
    if (!response.ok || !response.body) throw error('XGOVERNOR_STREAM_LOST', '无法领取本次事件流；不会重复提交任务')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let pending = ''
    try {
      while (true) {
        const chunk = await reader.read()
        pending = (pending + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, '\n')
        if (pending.length > 16 * 1024 * 1024) throw error('XGOVERNOR_EVENT_INVALID', '事件帧超过上限')
        let end
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2)
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          const event = JSON.parse(data)
          if (event.kind === 'extension' && event.runtime_id === runtimeId && event.turn_id == null) continue
          if (event.runtime_id !== runtimeId || event.turn_id !== turnId) throw error('XGOVERNOR_EVENT_MISMATCH', '事件与本次会话或 turn 不匹配')
          await onEvent?.(event)
          if (['turn_completed', 'turn_failed'].includes(event.kind)) return event
          if (event.kind === 'interaction_requested') throw error('AGENT_INTERACTION_UNSUPPORTED', 'Benchmark Agent 请求了交互输入')
        }
        if (chunk.done) break
      }
      throw error('XGOVERNOR_STREAM_LOST', '事件流未收到权威终态；不会重复提交任务')
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
}

module.exports = { XGovernorClient, error }
