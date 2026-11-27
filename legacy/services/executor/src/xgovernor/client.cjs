/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict'

const error = (code, message) => Object.assign(new Error(message), { code })

const SAFE_REASONS = [
  { phrases: ['model preflight timed out', 'pi model probe timed out'], code: 'MODEL_PREFLIGHT_TIMEOUT',
    message: '启动 Agent 前的模型检查未在规定时间内完成。请检查执行机到模型服务的连接，或稍后重试。' },
  { phrases: ['pi exited without a model probe result'], code: 'MODEL_PREFLIGHT_FAILED',
    message: 'Pi 在返回模型预检查结果前退出，请检查客户端安装和 Pi 扩展路径。' },
  { phrases: ['failed to start isolated pi model probe'], code: 'MODEL_PREFLIGHT_FAILED',
    message: '无法启动 Pi 模型预检查进程，请检查 Pi 可执行文件和运行环境。' },
  { phrases: ['model authentication failed'], code: 'MODEL_AUTHENTICATION_FAILED',
    message: '模型服务拒绝了认证，请检查执行机上所选 Agent 的模型凭据或登录状态。' },
  { phrases: ['model not found'], code: 'MODEL_NOT_FOUND',
    message: '所选模型不存在或不可用，请检查模型名称及当前账号的访问权限。' },
  { phrases: ['model request timed out'], code: 'MODEL_REQUEST_TIMEOUT',
    message: '模型请求未在规定时间内完成，请检查执行机到模型服务的连接，或稍后重试。' },
  { phrases: ['model endpoint connection failed', 'model connection failed'], code: 'MODEL_CONNECTION_FAILED',
    message: '无法连接模型服务，请检查执行机网络和所选模型的服务地址。' },
  { phrases: ['model rate limited'], code: 'MODEL_RATE_LIMITED',
    message: '模型服务请求受限，请检查服务配额或降低并发后重试。' },
  { phrases: ['invalid model response', 'model returned no assistant output'], code: 'MODEL_RESPONSE_INVALID',
    message: '模型服务返回的响应格式异常或缺少有效输出，请检查模型 API 协议与服务兼容性。' },
  { phrases: ['invalid model protocol or capabilities', 'invalid model request configuration'], code: 'MODEL_REQUEST_INVALID',
    message: '模型 API 协议或请求配置不合法，请检查所选 Agent 的模型配置。' },
  { phrases: ['model context limit exceeded'], code: 'MODEL_REQUEST_INVALID',
    message: '模型请求超过上下文限制，请检查模型上下文配置或缩短输入。' },
  { phrases: ['model provider request failed', 'model service request failed'], code: 'MODEL_SERVICE_ERROR',
    message: '模型服务处理请求失败，请检查服务状态或稍后重试。' },
  { phrases: ['invalid llm.api_base url'], code: 'MODEL_REQUEST_INVALID',
    message: '模型服务地址格式不合法，请检查所选 Agent 的模型服务地址。' },
  { phrases: ['model does not support reasoning'], code: 'MODEL_REQUEST_INVALID',
    message: '所选模型不支持当前推理配置，请调整模型配置后重试。' },
]
const REQUEST_FIELDS = new Set(['runtime_id', 'runtime_kind', 'conversation_id', 'sender_id', 'workspace', 'llm', 'provider', 'model', 'api', 'api_base', 'api_key_env', 'capabilities', 'reasoning', 'input', 'context_window', 'max_tokens', 'deployment', 'options', 'provider_options', 'network_mode', 'workspace_root', 'bootstrap', 'ext', 'runtime_pi', 'xiaoo', 'extension_dir', 'backend_id', 'tools_enabled', 'max_turns', 'discovery', 'allow_interaction', 'reasoning_effort'])

async function safeResponseReason(response) {
  if (!response.body) return ''
  let reader
  try { reader = response.body.getReader() } catch { return '' }
  let timer
  const read = async () => {
    const chunks = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 16384) return ''
        chunks.push(chunk.value)
      }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const text = new TextDecoder().decode(bytes)
      let message = text
      try {
        const body = JSON.parse(text)
        message = typeof body === 'string' ? body : typeof body.error === 'string' ? body.error : body.error?.message || body.message || ''
      } catch {}
      if (typeof message !== 'string') return ''
      const normalized = message.toLowerCase()
      const known = SAFE_REASONS.find(reason => reason.phrases.some(phrase => normalized.includes(phrase)))
      if (known) return { code: known.code, message: known.message }
      const field = message.match(/\b(unknown|missing) field [`'"]([a-z_]+)[`'"]/)
      if (field && REQUEST_FIELDS.has(field[2])) return { code: 'XGOVERNOR_REJECTED', message: `会话请求${field[1] === 'missing' ? '缺少必填' : '包含不支持的'}字段：${field[2]}` }
      return ''
    } catch { return '' }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  try {
    return await Promise.race([read(), new Promise(resolve => { timer = setTimeout(() => { reader.cancel().catch(() => {}); resolve('') }, 1000) })])
  } finally { clearTimeout(timer) }
}

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
    if (!response.ok) {
      const reason = await safeResponseReason(response)
      throw error(reason?.code || 'XGOVERNOR_REJECTED', reason?.message || `执行环境请求失败（HTTP ${response.status}）`)
    }
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
