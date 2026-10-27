'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { error } = require('./client.cjs')
const candidates = [path.resolve(__dirname, '../../../../scripts/agent-trace-collectors/shared/trace-transport.cjs'), path.resolve(__dirname, '../vendor/trace-transport.cjs')]
function transport() { return require(candidates.find(file => fs.existsSync(file)) || candidates[0]) }
const { traceApiKey } = require('./credentials.cjs')
const uploaders = new Map()
function resumeUpload(handle, config, insightBaseUrl) {
  const stateDir = path.join(handle.opaque.directory, 'trace-spool')
  const apiKey = traceApiKey(config)
  if (!apiKey || !fs.existsSync(stateDir)) return null
  if (!uploaders.has(stateDir)) {
    const { DurableTraceUploader } = transport()
    const uploader = new DurableTraceUploader({ framework: handle.opaque.platform, apiKey, stateDir, endpoint: `${insightBaseUrl}/api/ingest/otel/v1/traces`, maxRetries: 0, redactLocalPaths: false, cleanupRetention: false,
      fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) }),
    })
    const flush = uploader.flushOnce.bind(uploader)
    uploader.flushOnce = async () => {
      const result = await flush()
      if (result.acquired && !result.deferred) { uploader.stop(); uploaders.delete(stateDir) }
      return result
    }
    uploader.start(15000)
    uploaders.set(stateDir, uploader)
  }
  return uploaders.get(stateDir)
}

function piEvents(records, metadata) {
  const { stableSpanId, stableTraceId, stableEventId } = transport()
  const sessionId = `xgovernor:${metadata.runId}`
  const traceId = stableTraceId('pi-agent', sessionId)
  const root = stableSpanId(sessionId, 'agent')
  const messages = records.filter(item => item.type === 'message' && item.message).map(item => item.message)
  if ((!metadata.partial && !messages.some(item => item.role === 'assistant')) || !messages.some(item => item.role === 'user')) throw error('TRACE_INCOMPLETE', 'Pi 原生轨迹缺少用户或模型消息')
  const events = []
  const pending = new Map()
  let previous = metadata.startedAt
  let output = ''
  for (const [index, message] of messages.entries()) {
    const end = Math.max(previous, Number(message.timestamp) || Date.parse(message.timestamp) || previous)
    const common = { sessionId, traceId, startTimeMs: previous, endTimeMs: end, status: 'success' }
    if (message.role === 'assistant') {
      const spanId = stableSpanId(sessionId, 'llm', index)
      output = message.content
      const usage = message.usage || {}
      events.push({ ...common, spanId, parentSpanId: root, kind: 'llm', name: `llm.${message.model || metadata.model || 'unknown'}`, input: messages.slice(0, index), output: message.content, model: message.model || metadata.model, provider: message.provider || metadata.provider,
        usage: message.usage ? { input: usage.input, output: usage.output, total: usage.totalTokens ?? ((usage.input || 0) + (usage.output || 0)), reasoning: usage.reasoning } : undefined,
      })
      for (const call of message.content || []) if (['toolCall', 'tool_call'].includes(call.type)) pending.set(call.id, { call, parentSpanId: spanId, startTimeMs: end })
    } else if (['toolResult', 'tool_result'].includes(message.role)) {
      const call = pending.get(message.toolCallId)
      if (!call) throw error('TRACE_INCOMPLETE', 'Pi 工具结果没有对应调用')
      pending.delete(message.toolCallId)
      events.push({ ...common, startTimeMs: call.startTimeMs, spanId: stableSpanId(sessionId, 'tool', message.toolCallId), parentSpanId: call.parentSpanId, kind: 'tool', name: `tool.${call.call.name}`, status: message.isError ? 'error' : 'success', tool: { name: call.call.name, type: 'function', arguments: call.call.arguments, result: message.content } })
    }
    previous = end
  }
  if (pending.size && !metadata.partial) throw error('TRACE_INCOMPLETE', 'Pi 工具调用缺少结果')
  events.push({ sessionId, traceId, spanId: root, kind: 'agent', name: 'agent.pi-agent', input: metadata.input, output, startTimeMs: metadata.startedAt, endTimeMs: Math.max(previous, Date.now()), status: metadata.partial ? 'running' : metadata.failed ? 'error' : 'success' })
  return events.map(event => ({ ...event, eventId: stableEventId(sessionId, event.spanId), attributes: { 'benchmark.run_id': metadata.runId, 'xgovernor.runtime_id': metadata.runtimeId, ...(event.kind === 'agent' ? { 'agent.insight.trace.completed': !metadata.partial } : {}) } }))
}

function xiaooEvents(snapshot, metadata) {
  if (snapshot.runtime_kind !== 'xiaoo' || snapshot.schema_version !== 1) throw error('TRACE_SCHEMA_UNSUPPORTED', 'xiaoO worker state 版本不兼容')
  const messages = snapshot.state?.loop_state?.messages
  if (!Array.isArray(messages)) throw error('TRACE_SCHEMA_UNSUPPORTED', 'xiaoO worker state 缺少完整消息历史')
  const records = messages.flatMap(message => {
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role) || !Array.isArray(message.blocks)) throw error('TRACE_SCHEMA_UNSUPPORTED', 'xiaoO ChatMessage 格式不兼容')
    if (message.blocks.some(block => !['text', 'tool_use', 'tool_result', 'image', 'document'].includes(block.type))) throw error('TRACE_SCHEMA_UNSUPPORTED', 'xiaoO ContentBlock 格式不兼容')
    if (message.role === 'tool') {
      if (!message.blocks.length || message.blocks.some(block => block.type !== 'tool_result')) throw error('TRACE_SCHEMA_UNSUPPORTED', 'xiaoO 工具结果格式不兼容')
      return message.blocks.map(block => ({ type: 'message', message: {
        role: 'toolResult', toolCallId: block.call_id, toolName: block.tool_name, content: [{ type: 'text', text: block.output }], isError: block.is_error, timestamp: message.timestamp_ms,
      } }))
    }
    const content = message.blocks.map(block => block.type === 'tool_use' ? { type: 'toolCall', id: block.call_id, name: block.tool_name, arguments: block.input } : block)
    if (message.reasoning_content) content.push({ type: 'thinking', thinking: message.reasoning_content })
    return [{ type: 'message', message: {
      role: message.role, content, model: metadata.model, timestamp: message.timestamp_ms,
      ...(Number.isSafeInteger(message.api_usage_tokens) ? { usage: { totalTokens: message.api_usage_tokens } } : {}),
    } }]
  })
  return piEvents(records, metadata).map(event => ({ ...event, traceId: transport().stableTraceId('xiaoo', event.sessionId), name: event.kind === 'agent' ? 'agent.xiaoo' : event.name }))
}

async function exportTrace(handle, runtime, config, context, processRunner) {
  const model = handle.opaque.resolvedModel || config.models[handle.opaque.modelId] || {}
  const metadata = { model: model.model || context.model, provider: model.provider, runId: handle.runId, runtimeId: handle.opaque.runtimeId, stateDirectory: path.join(handle.opaque.directory, 'state'), startedAt: handle.opaque.startedAt, input: context.input, failed: Boolean(context.failed), partial: Boolean(context.partial) }
  let events
  try {
    if (runtime.traceExporter) {
      const result = await processRunner(runtime.traceExporter, ['--export'], { input: JSON.stringify(metadata), timeoutMs: 30000, maxOutputBytes: 64 * 1024 * 1024 })
      const exported = JSON.parse(result.stdout)
      if (exported.schemaVersion !== 'execution-trace/v1' || exported.full !== true || exported.runtimeId !== metadata.runtimeId || exported.runId !== metadata.runId || !Array.isArray(exported.events)) throw error('TRACE_INCOMPLETE', 'Trace 导出器返回了不兼容或不完整的数据')
      events = exported.events
    } else if (runtime.kind === 'xiaoo') {
      const snapshot = JSON.parse(await fsp.readFile(path.join(handle.opaque.directory, 'worker-state.json'), 'utf8'))
      events = xiaooEvents(snapshot, metadata)
    } else {
      const directory = path.join(metadata.stateDirectory, 'pi-sessions', metadata.runtimeId)
      const files = (await fsp.readdir(directory, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.jsonl'))
      if (files.length !== 1) throw error('TRACE_INCOMPLETE', '本次 Pi 会话没有唯一的原生 JSONL')
      const text = await fsp.readFile(path.join(directory, files[0].name), 'utf8')
      events = piEvents(text.split('\n').filter(line => line.trim()).map((line, index, lines) => { try { return JSON.parse(line) } catch (cause) { if (metadata.partial && index === lines.length - 1 && !text.endsWith('\n')) return null; throw cause } }).filter(Boolean), metadata)
    }
  } catch (cause) {
    if (!metadata.partial || runtime.traceExporter || !['ENOENT', 'TRACE_INCOMPLETE'].includes(cause.code)) throw cause
    const { stableSpanId, stableTraceId, stableEventId } = transport()
    const sessionId = `xgovernor:${handle.runId}`
    const spanId = stableSpanId(sessionId, 'agent')
    events = [{ kind: 'agent', sessionId, spanId, eventId: stableEventId(sessionId, spanId), traceId: stableTraceId(context.platform, sessionId), name: `agent.${context.platform}`,
      input: metadata.input, startTimeMs: metadata.startedAt, endTimeMs: Date.now(), status: 'running' }]
  }
  events = events.map(event => ({ ...event,
    ...(metadata.partial && event.kind === 'agent' && !event.parentSpanId ? { status: 'running' } : {}),
    attributes: { ...event.attributes, 'xgovernor.runtime_id': metadata.runtimeId, 'benchmark.run_id': metadata.runId,
      ...(event.kind === 'agent' && !event.parentSpanId ? { 'agent.insight.trace.completed': !metadata.partial } : {}) },
  }))
  const roots = events.filter(event => event.kind === 'agent' && !event.parentSpanId)
  const root = roots[0]
  if (roots.length !== 1 || root.sessionId !== `xgovernor:${handle.runId}` || !metadata.partial && !events.some(event => event.kind === 'llm') || events.some(event => event.sessionId !== root.sessionId)) throw error('TRACE_INCOMPLETE', 'Trace 必须包含唯一根会话及模型正文')
  const { DurableTraceWriter } = transport()
  const apiKey = traceApiKey(config)
  const stateDir = path.join(handle.opaque.directory, 'trace-spool')
  const framework = context.platform
  const writer = new DurableTraceWriter({ framework, apiKey, stateDir, redactLocalPaths: false })
  for (const event of events) await writer.append(event)
  await writer.flush()
  const uploader = resumeUpload(handle, config, context.insightBaseUrl)
  if (!uploader) throw error('TRACE_AUTH_MISSING', 'Trace 采集认证不可用，请重新运行客户端安装命令')
  uploader.flushOnce().catch(() => {})
  return { traceId: root.sessionId }
}

function liveTraceReporter(handle, runtime, config, context, processRunner, options = {}) {
  let pending = null
  let stopped = false
  const tick = () => {
    if (stopped || pending) return pending
    pending = (options.exportTrace || exportTrace)(handle, runtime, config, { ...context, partial: true }, processRunner)
      .then(trace => context.onTraceId?.(trace))
      .catch(cause => options.log?.('运行中 Trace 上传暂未完成', cause.message))
      .finally(() => { pending = null })
    return pending
  }
  const timer = setInterval(tick, options.intervalMs || 1000)
  timer.unref?.()
  void tick()
  return { tick, async stop() { stopped = true; clearInterval(timer); await pending } }
}

module.exports = { liveTraceReporter, exportTrace, piEvents, xiaooEvents, transport, resumeUpload, hasActiveUpload: directory => uploaders.has(path.join(directory, 'trace-spool')) }
