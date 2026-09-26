function collectDiagnosticStrings(value, output = [], depth = 0) {
  if (depth > 5 || output.length >= 20 || value === null || value === undefined) return output
  if (typeof value === 'string') {
    if (value.trim()) output.push(value.trim())
    return output
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDiagnosticStrings(item, output, depth + 1)
    return output
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:authorization|[a-z0-9_]*(?:api[_-]?key|access[_-]?token)|token|secret|client[_-]?secret)$/i.test(key)) {
        output.push('[REDACTED]')
      } else {
        collectDiagnosticStrings(item, output, depth + 1)
      }
    }
  }
  return output
}

function extractStructuredAgentError(line) {
  try {
    const parsed = typeof line === 'string' ? JSON.parse(line.trim()) : line
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const type = String(parsed.type || '').toLowerCase()
    const nestedEvent = parsed.event && typeof parsed.event === 'object' ? parsed.event : null
    const nestedType = String(nestedEvent?.type || '').toLowerCase()
    const nestedError = nestedEvent?.properties?.error || nestedEvent?.properties?.info?.error || nestedEvent?.error
    const directError = parsed.error || parsed.properties?.error || parsed.properties?.info?.error || parsed.info?.error || parsed.message?.error
    if (
      !['error', 'session.error'].includes(type)
      && !['error', 'session.error'].includes(nestedType)
      && !directError
      && !nestedError
    ) return null
    const values = collectDiagnosticStrings(
      directError || nestedError || parsed.message || nestedEvent || parsed,
    )
    return values.join(' | ').slice(-4_000) || null
  } catch {
    return null
  }
}


function sanitizeAgentDiagnostic(value, maxLength = 800) {
  const compact = String(value || '')
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s,'"}]+/gi, '$1[REDACTED]')
    .replace(/((?:[a-z0-9_]*(?:api[_-]?key|access[_-]?token)|token|secret|client[_-]?secret)["']?\s*[:=]\s*["']?)[^\s,'"}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|rk|pk)-[a-z0-9_-]{16,}\b/gi, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
  return compact.length > maxLength ? compact.slice(-maxLength) : compact
}

function classifyAgentExitFailure({ platform, exitCode, signal, diagnostic, structured = false }) {
  const normalized = sanitizeAgentDiagnostic(diagnostic)
  const strictModelSelectionFailure = /(?:modelnotfound|unknownmodel|invalidmodel|(?:unknown|invalid|unsupported)\s+model|requested\s+model\s+[^.]{0,100}(?:not found|does not exist)|model\s+(?:id|name)\s+[^.]{0,100}(?:not found|does not exist|invalid)|provider\s+(?:[^.]{0,100}\s+)?(?:not found|unknown|invalid)|no\s+(?:model|provider)\s+(?:was\s+)?found|模型(?:名称|标识)?[^。]{0,60}(?:不存在|未找到|无效|不支持))/i
  const structuredModelSelectionFailure = /(?:model\s+(?:[^.]{0,100}\s+)?(?:not found|does not exist|unknown|invalid|unsupported)|(?:unknown|invalid|unsupported)\s+model)/i
  const modelContext = /(?:model|provider|\bllm\b|openai|anthropic|gemini|deepseek|api[_ -]?key|模型|提供商|密钥|鉴权)/i
  const authenticationFailure = /(?:providerauth|authentication\s+(?:failed|required)|unauthori[sz]ed|forbidden|permission\s+denied|access\s+denied|not\s+authorized|invalid\s+(?:api[_ -]?key|credential|access[_ -]?token)|(?:api[_ -]?key|credential|access[_ -]?token)\s+(?:is\s+)?(?:invalid|missing|expired|revoked)|\b(?:401|403)\b|鉴权失败|未授权|密钥[^。]{0,40}(?:无效|缺失|过期))/i
  const exitDescription = exitCode === null || exitCode === undefined
    ? `signal ${signal || 'unknown'}`
    : `exit ${exitCode}`

  if (
    strictModelSelectionFailure.test(normalized)
    || (platform === 'pi-agent' && /Model "[^"]+" not found\./.test(normalized))
    || (structured && structuredModelSelectionFailure.test(normalized))
    || (modelContext.test(normalized) && authenticationFailure.test(normalized))
  ) {
    return {
      code: 'MODEL_UNAVAILABLE',
      message: `平台 ${platform} 无法使用所选模型（模型名称、鉴权或配置错误；${exitDescription}）`,
    }
  }
  return {
    code: 'AGENT_EXIT_NONZERO',
    message: `平台 ${platform} Agent 异常退出（${exitDescription}）`,
  }
}

function createAgentRunError(code, message, runFacts) {
  const err = new Error(message)
  err.code = code
  err.runFacts = runFacts
  return err
}


function createOpencodeFailureMonitor({ inspectEvent, onFailure, schedule = setTimeout, cancel = clearTimeout }) {
  let retry = null
  let timer = null
  let failure = null
  let buffer = ''
  let closed = false
  const clearRetry = () => {
    if (timer !== null) cancel(timer)
    timer = null
    retry = null
  }
  const fail = (code, message) => {
    if (closed || failure) return
    failure = { code, message: sanitizeAgentDiagnostic(message), detectedAt: new Date().toISOString() }
    clearRetry()
    onFailure(failure.code, failure.message)
  }
  const unavailable = (message) => classifyAgentExitFailure({
    platform: 'opencode', diagnostic: `model provider: ${message}`, structured: true,
  }).code === 'MODEL_UNAVAILABLE'
  const observeRetry = (value) => {
    if (closed || failure) return
    const message = sanitizeAgentDiagnostic(value.message || '模型请求重试')
    if (unavailable(message)) {
      fail('MODEL_UNAVAILABLE', `opencode 模型配置或鉴权失败：${message}`)
      return
    }
    if (!retry) {
      retry = { message }
      timer = schedule(() => fail('MODEL_ERROR', `opencode 模型请求失败，重试后 10 秒内未恢复：${retry?.message || message}`), 10_000)
    }
    retry.message = message
    // stdout 与 stderr 可重复报告同一 attempt，不能按消息条数累加。
    if (Number(value.attempt) >= 2) fail('MODEL_ERROR', `opencode 模型请求重试后仍失败：${message}`)
  }
  const onEvent = (event) => {
    if (closed || failure || !event) return
    if (event.modelResponse) { clearRetry(); buffer = '' }
    if (event.retry) observeRetry(event.retry)
  }
  const consume = (line) => {
    const text = require('node:util').stripVTControlCharacters(line).trim()
    if (!text || closed || failure) return
    if (text.startsWith('{')) {
      const event = inspectEvent(text)
      // stderr 中只采信运行时生命周期信号，不扫描回答或工具输出中的错误文字。
      if (!event || !['error', 'session.error', 'session.status'].includes(event.type)) return
      if (event.error) {
        fail(unavailable(event.error) ? 'MODEL_UNAVAILABLE' : 'MODEL_ERROR', `opencode 模型错误：${event.error}`)
      }
      else onEvent(event)
      return
    }
    if (!/^(?:Error:\s*)?(?:Cannot connect to API:|ProviderAuthError:|ModelNotFoundError:|ProviderModelNotFoundError:|APIKeyMissingError:|Unauthorized\b|Invalid API key\b|Unknown model\b|Model not found\b)/i.test(text)) return
    if (unavailable(text)) fail('MODEL_UNAVAILABLE', `opencode 模型配置或鉴权失败：${text}`)
    else observeRetry({ message: text, attempt: text.match(/\battempt\s*#?\s*(\d+)/i)?.[1] })
  }
  return {
    onEvent,
    onStderr(chunk) {
      if (closed) return
      buffer += chunk
      const lines = buffer.split(/\r\n|[\r\n]/)
      buffer = lines.pop() || ''
      for (const line of lines) consume(line)
      consume(buffer)
      if (buffer.length > 64 * 1024) buffer = buffer.slice(-64 * 1024)
    },
    finish() {
      consume(buffer)
      if (!failure && retry) fail('MODEL_ERROR', `opencode 模型请求失败，退出前未恢复：${retry.message}`)
      return failure
    },
    dispose() { closed = true; clearRetry(); buffer = '' },
  }
}

module.exports = { extractStructuredAgentError, sanitizeAgentDiagnostic, classifyAgentExitFailure, createAgentRunError, createOpencodeFailureMonitor }
