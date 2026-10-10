const { randomBytes } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

function prepareOpencodeEventChannel(env) {
  let config
  try { config = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}') }
  catch { throw Object.assign(new Error('OpenCode 进程配置无法解析，无法启用失败监测通道'), { code: 'EVENT_MONITOR_UNAVAILABLE' }) }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw Object.assign(new Error('OpenCode 进程配置必须为对象'), { code: 'EVENT_MONITOR_UNAVAILABLE' })
  }
  const token = randomBytes(24).toString('hex')
  const plugin = pathToFileURL(path.join(__dirname, 'opencode-experiment-events.mjs')).href
  return {
    token,
    env: {
      AGENT_INSIGHT_EVENT_TOKEN: token,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugin: [...new Set([...(config.plugin || []), plugin])] }),
    },
  }
}

function createOpencodeEventReader(token, { onReady, onSession, onEvent, onModel, onTrigger }) {
  let buffer = ''
  let ready = false
  let sessionId = null
  let signalCount = 0
  let completed = false
  return {
    get ready() { return ready },
    get sessionId() { return sessionId },
    get completed() { return completed },
    get signalCount() { return signalCount },
    push(chunk) {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      if (buffer.length > 64 * 1024) buffer = ''
      for (const line of lines) {
        let frame
        try { frame = JSON.parse(line) } catch { continue }
        if (frame.protocol !== 1 || frame.token !== token) continue
        if (frame.kind === 'ready' && !ready) { ready = true; onReady(); continue }
        if (!ready) continue
        if (frame.kind === 'session' && !sessionId && typeof frame.sessionId === 'string') {
          sessionId = frame.sessionId
          onSession(sessionId)
        } else if (frame.kind === 'event' && sessionId && frame.sessionId === sessionId && frame.signal) {
          signalCount++
          onEvent(frame.signal)
        } else if (frame.kind === 'model' && sessionId && frame.sessionId === sessionId) {
          onModel?.(frame.model)
        } else if (frame.kind === 'trigger' && sessionId && frame.sessionId === sessionId) {
          onTrigger?.(frame.skillName)
        } else if (frame.kind === 'finished' && sessionId && frame.sessionId === sessionId) {
          completed = true
        }
      }
    },
  }
}

module.exports = { prepareOpencodeEventChannel, createOpencodeEventReader }
