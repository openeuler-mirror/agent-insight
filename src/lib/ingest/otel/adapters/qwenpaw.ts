import type { ExecutionRecord } from '@/lib/storage/data-service'
import type { OtelTraceEvent } from '../types'
import type { OtelTraceAdapter } from './types'

type AnyObj = Record<string, any>
const USER_ROLES = new Set(['user', 'human'])
const PLACEHOLDER_QUERY = 'QwenPaw Session'
const PLACEHOLDER_SESSION_IDS = new Set(['', 'unknown', 'none', 'null', 'undefined'])

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString()
}

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0)
}

function qwenpawSessionId(event: OtelTraceEvent): string {
  return firstContent(attr(event, 'qwenpaw.session_id')) || event.sessionId
}

function isPlaceholderSessionId(value: any): boolean {
  return PLACEHOLDER_SESSION_IDS.has(String(value || '').trim().toLowerCase())
}

function asContent(value: any): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? value : undefined
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return undefined
    }
  }
  return String(value)
}

function firstContent(...values: any[]): string | undefined {
  for (const value of values) {
    const content = asContent(value)
    if (content) return content
  }
  return undefined
}

function attr(event: OtelTraceEvent, ...keys: string[]): any {
  const attrs = event.attributes || {}
  for (const key of keys) {
    if (attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '') {
      return attrs[key]
    }
  }
  return undefined
}

function eventModel(event: OtelTraceEvent): string | undefined {
  return firstContent(
    event.model,
    attr(event, 'gen_ai.request.model', 'llm.request.model', 'llm.model_name', 'gen_ai.response.model'),
  )
}

function tokenTotal(event: OtelTraceEvent): number {
  const usage = event.usage || {}
  return usage.total_tokens ||
    (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.reasoning_tokens || 0)
}

function spanKind(event: OtelTraceEvent): string {
  return String(
    attr(event, 'gen_ai.span.kind', 'openinference.span.kind', 'traceloop.span.kind', 'span.kind') || '',
  ).toUpperCase()
}

function isAgentSpan(event: OtelTraceEvent): boolean {
  return spanKind(event) === 'AGENT' || String(event.name || '').toLowerCase() === 'agent'
}

function isSubagentSpan(event: OtelTraceEvent): boolean {
  const sessionId = qwenpawSessionId(event)
  const rootSessionId = firstContent(attr(event, 'qwenpaw.root_session_id')) || event.sessionId
  const hasRealSessionIds = !isPlaceholderSessionId(sessionId) && !isPlaceholderSessionId(rootSessionId)
  return (
    (hasRealSessionIds && sessionId !== rootSessionId) ||
    attr(event, 'qwenpaw.parent_session_id', 'subagent.parent.session.id') !== undefined ||
    (attr(event, 'subagent.session.id') !== undefined && !isPlaceholderSessionId(attr(event, 'subagent.session.id'))) ||
    attr(event, 'agent.subagent') === true ||
    attr(event, 'agent.subagent') === 'true'
  )
}

function isLlmSpan(event: OtelTraceEvent): boolean {
  if (event.kind !== 'llm') return false
  if (isAgentSpan(event)) return false
  const attrs = event.attributes || {}
  return (
    spanKind(event) === 'LLM' ||
    String(event.name || '').startsWith('llm.') ||
    attrs['llm.model_name'] !== undefined ||
    attrs['input.value'] !== undefined ||
    attrs['output.value'] !== undefined
  )
}

function isToolSpan(event: OtelTraceEvent): boolean {
  return event.kind === 'tool' || spanKind(event) === 'TOOL' || attr(event, 'tool.name') !== undefined
}

function isSkillSpan(event: OtelTraceEvent): boolean {
  return attr(event, 'skill.name') !== undefined || String(event.name || '').startsWith('skill.')
}

function isMcpSpan(event: OtelTraceEvent): boolean {
  return (
    attr(event, 'mcp.server.name', 'mcp.tool.name') !== undefined ||
    attr(event, 'protocol') === 'mcp' ||
    String(attr(event, 'tool.name') || '').startsWith('mcp__')
  )
}

function isCronSpan(event: OtelTraceEvent): boolean {
  return attr(event, 'cron.job_id') !== undefined
}

function isSessionEndSpan(event: OtelTraceEvent): boolean {
  if (isSubagentSpan(event)) return false
  return (
    attr(event, 'qwenpaw.session.end') === true ||
    attr(event, 'qwenpaw.session.end') === 'true' ||
    String(event.name || '') === 'qwenpaw.session.end'
  )
}

function isInternalTitleSpan(event: OtelTraceEvent): boolean {
  const op = String(attr(event, 'qwenpaw.internal_operation') || '').toLowerCase()
  return op === 'title_generation' || attr(event, 'qwenpaw.title_generation') === true || attr(event, 'qwenpaw.title_generation') === 'true'
}

function parseMaybeJson(value: string | undefined): any {
  if (!value) return value
  const text = value.trim()
  if (!text || (!text.startsWith('{') && !text.startsWith('['))) return value
  try {
    return JSON.parse(text)
  } catch {
    return value
  }
}

function stringifyMessageContent(content: any): string {
  if (content === undefined || content === null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part?.text) return String(part.text)
        if (part?.content) return stringifyMessageContent(part.content)
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (typeof content === 'object') {
    if (content.text) return String(content.text)
    if (content.content) return stringifyMessageContent(content.content)
  }
  return String(content)
}

function cleanText(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim()
  return trimmed ? trimmed : undefined
}

function latestUserMessage(value: any): string | undefined {
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : value
  const messages = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.messages)
      ? parsed.messages
      : Array.isArray(parsed?.input)
        ? parsed.input
      : undefined
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!message || typeof message !== 'object') continue
    if (!USER_ROLES.has(String(message.role || '').toLowerCase())) continue
    const text = stringifyMessageContent(message.content)
    const cleaned = cleanText(text)
    if (cleaned) return cleaned
  }
  return undefined
}

function userPromptContent(attrs: Record<string, any>): string | undefined {
  const at = (index: number): string | undefined => {
    const value = attrs[`gen_ai.prompt.${index}.content`]
    const text = asContent(value)
    return cleanText(text)
  }
  for (let index = 0; index < 32; index++) {
    if (attrs[`gen_ai.prompt.${index}.content`] === undefined) continue
    if (USER_ROLES.has(String(attrs[`gen_ai.prompt.${index}.role`] || '').toLowerCase())) {
      return at(index)
    }
  }
  return undefined
}

function decodePythonString(value: string): string {
  return value
    .replace(/\\\\n/g, '\n')
    .replace(/\\\\r/g, '\r')
    .replace(/\\\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(['"\\])/g, '$1')
}

function pythonKeywordStrings(text: string, keyword: string): string[] {
  const values: string[] = []
  let index = 0
  const needle = `${keyword}=`
  while (index < text.length) {
    const found = text.indexOf(needle, index)
    if (found < 0) break
    let cursor = found + needle.length
    while (/\s/.test(text[cursor] || '')) cursor++
    const quote = text[cursor]
    if (quote !== '\'' && quote !== '"') {
      index = cursor + 1
      continue
    }
    cursor++
    let raw = ''
    while (cursor < text.length) {
      const ch = text[cursor]
      if (ch === '\\') {
        raw += ch
        if (cursor + 1 < text.length) raw += text[cursor + 1]
        cursor += 2
        continue
      }
      if (ch === quote) break
      raw += ch
      cursor++
    }
    values.push(decodePythonString(raw))
    index = cursor + 1
  }
  return values
}

function userMessageFromQwenPawReprItem(item: unknown): string | undefined {
  if (typeof item !== 'string') return undefined
  const role = pythonKeywordStrings(item, 'role').at(-1)?.trim().toLowerCase()
  if (!role || !USER_ROLES.has(role)) return undefined
  const text = pythonKeywordStrings(item, 'text')
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
  if (text) return text
  return cleanText(pythonKeywordStrings(item, 'content').join('\n'))
}

function latestQwenPawReprUserMessage(value: unknown): string | undefined {
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : value
  const messages = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.messages)
      ? (parsed as any).messages
      : Array.isArray((parsed as any)?.input)
        ? (parsed as any).input
        : undefined
  if (!messages) {
    return userMessageFromQwenPawReprItem(parsed)
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = userMessageFromQwenPawReprItem(messages[i])
    if (text) return text
  }
  return undefined
}

function userTextFromDirectAttr(event: OtelTraceEvent): string | undefined {
  return firstContent(attr(event, 'qwenpaw.user_input'))
}

function userTextFromStandardMessages(event: OtelTraceEvent): string | undefined {
  const attrs = event.attributes || {}
  return latestUserMessage(attrs['gen_ai.input.messages']) ||
    latestUserMessage(attrs['gen_ai.input.message']) ||
    latestUserMessage(attrs['llm.input_messages']) ||
    latestUserMessage(attrs['input.messages']) ||
    latestUserMessage(attrs['request.messages']) ||
    latestUserMessage(attrs['requestMessages']) ||
    latestUserMessage(attrs.messages) ||
    userPromptContent(attrs)
}

function userTextFromLegacyInput(event: OtelTraceEvent): string | undefined {
  const raw = attr(event, 'input.value')
  return latestUserMessage(raw) ||
    latestQwenPawReprUserMessage(raw) ||
    (isAgentSpan(event) ? firstContent(raw) : undefined)
}

function assistantText(value: string | undefined): string | undefined {
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : undefined
  if (!parsed || typeof parsed !== 'object') return undefined
  const choices = Array.isArray(parsed.choices) ? parsed.choices : undefined
  if (choices) {
    const text = choices
      .map((choice: any) => stringifyMessageContent(
        choice?.message?.content ?? choice?.delta?.content ?? choice?.text,
      ))
      .filter((part: string) => part.trim())
      .join('\n')
    if (text.trim()) return text
  }
  return firstContent(
    parsed.output_text,
    parsed.message?.content,
    parsed.content,
    parsed.text,
  )
}

function inputText(event: OtelTraceEvent | undefined): string | undefined {
  if (!event) return undefined
  return userTextFromDirectAttr(event) ||
    userTextFromStandardMessages(event) ||
    userTextFromLegacyInput(event)
}

function userTurnKey(event: OtelTraceEvent, content: string): string {
  const explicit = firstContent(attr(event, 'qwenpaw.turn_id'))
  if (explicit) return explicit
  return `legacy:${content}`
}

function outputText(event: OtelTraceEvent | undefined): string | undefined {
  if (!event) return undefined
  const raw = firstContent(attr(event, 'output.value'))
  if (!raw) return undefined
  const parsed = parseMaybeJson(raw)
  if (parsed && typeof parsed === 'object') {
    return assistantText(raw)
  }
  return raw
}

function usageFor(events: OtelTraceEvent[]) {
  return {
    input_tokens: events.reduce((sum, event) => sum + (event.usage?.input_tokens || 0), 0),
    output_tokens: events.reduce((sum, event) => sum + (event.usage?.output_tokens || 0), 0),
    reasoning_tokens: events.reduce((sum, event) => sum + (event.usage?.reasoning_tokens || 0), 0),
    total: events.reduce((sum, event) => sum + tokenTotal(event), 0),
  }
}

function ownerFields(event: OtelTraceEvent, framework: string): AnyObj {
  const agentName = firstContent(attr(event, 'qwenpaw.agent.name', 'agent.name')) || framework
  const sessionId = qwenpawSessionId(event)
  const parentSessionId = firstContent(attr(event, 'qwenpaw.parent_session_id'))
  if (isSubagentSpan(event) || parentSessionId) {
    return {
      role: 'subagent',
      agent: agentName,
      subagent_name: agentName,
      subagent_session_id: firstContent(attr(event, 'subagent.session.id')) || sessionId,
      ...(parentSessionId ? { parent_subagent_session_id: parentSessionId } : {}),
    }
  }
  return { role: 'assistant', agent: agentName }
}

function makeUserInteraction(args: {
  content: string
  event: OtelTraceEvent
  framework: string
  owner?: AnyObj
}): AnyObj {
  const created = args.event.startTimeMs || Date.parse(args.event.receivedAt) || Date.now()
  const owner = args.owner || ownerFields(args.event, args.framework)
  return {
    ...owner,
    role: 'user',
    content: args.content,
    timestamp: toIso(created),
    timeInfo: { created: toIso(created), completed: toIso(created) },
    traceId: args.event.traceId,
    spanId: `${args.event.spanId || 'agent'}:input`,
  }
}

function makeSystemInteraction(args: {
  content: string
  event: OtelTraceEvent
  framework: string
}): AnyObj {
  const created = args.event.startTimeMs || Date.parse(args.event.receivedAt) || Date.now()
  return {
    role: 'system',
    agent: args.framework,
    content: args.content,
    system_prompt_length: args.content.length,
    timestamp: toIso(created),
    timeInfo: { created: toIso(created), completed: toIso(created) },
    traceId: args.event.traceId,
    spanId: `${args.event.spanId || 'agent'}:system`,
  }
}

function buildToolCall(event: OtelTraceEvent): AnyObj {
  const attrs = event.attributes || {}
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now()
  const completed = eventEndMs(event) || created
  const output = firstContent(
    attr(event, 'tool.output', 'tool.result', 'mcp.result', 'skill.output'),
    attrs['output.value'],
  )
  const status = String(attr(event, 'tool.status', 'tool.outcome') || 'success').toLowerCase()
  const state = status === 'error' || status === 'failed' ? 'error' : 'success'
  const rawName = String(attr(event, 'tool.name') || event.name || 'tool').replace(/^tool\./, '')
  const name = isSkillSpan(event)
    ? `skill.${String(attr(event, 'skill.name') || rawName).replace(/^skill\./, '')}`
    : rawName
  const argumentsValue = firstContent(
    attr(event, 'tool.arguments', 'tool.input', 'mcp.arguments', 'skill.input'),
    attrs['input.value'],
  )
  const call: AnyObj = {
    id: event.spanId,
    type: 'function',
    state,
    function: {
      name,
      arguments: argumentsValue || JSON.stringify(attrs),
    },
    output,
    result: output,
    timing: {
      started_at: toIso(created),
      completed_at: toIso(completed),
    },
  }
  if (isMcpSpan(event)) {
    call.mcp = {
      server_name: attr(event, 'mcp.server.name'),
      tool_name: attr(event, 'mcp.tool.name'),
    }
  }
  if (isSkillSpan(event)) {
    call.skill = {
      name: attr(event, 'skill.name'),
      version: attr(event, 'skill.version'),
      trigger: attr(event, 'skill.trigger'),
    }
  }
  if (attr(event, 'tool.exit_code') !== undefined) {
    call.exit_code = attr(event, 'tool.exit_code')
  }
  return call
}

function parseStructuredValue(value: any): any {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return value
  }
}

function delegationKind(event: OtelTraceEvent): string | undefined {
  const toolName = String(attr(event, 'tool.name') || event.name || '').replace(/^tool\./, '')
  const explicit = cleanText(firstContent(attr(event, 'qwenpaw.delegation.kind')))
  if (explicit) return explicit
  if (['spawn_subagent', 'spawn_batch', 'chat_with_agent', 'submit_to_agent'].includes(toolName)) return toolName
  return undefined
}

function sessionIdsFromText(value: any): string[] {
  const text = firstContent(value) || ''
  const seen = new Set<string>()
  const sessions: string[] = []
  const regex = /\[SESSION:\s*([^\]\s]+)\s*\]|\b(sub-[A-Za-z0-9_.:-]+)\b/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const sessionId = (match[1] || match[2])?.trim()
    if (sessionId && !seen.has(sessionId)) {
      seen.add(sessionId)
      sessions.push(sessionId)
    }
  }
  return sessions
}

function delegationChildren(event: OtelTraceEvent): string[] {
  const direct = parseStructuredValue(attr(event, 'qwenpaw.delegation.children'))
  const values = Array.isArray(direct) ? direct : direct ? [direct] : []
  const sessions = values
    .map((item) => typeof item === 'string' ? item : item?.session_id ?? item?.sessionId ?? item?.subagent_session_id)
    .map((value) => String(value || '').trim())
    .filter(Boolean)
  const fromOutput = sessionIdsFromText(attr(event, 'tool.output', 'output.value'))
  return Array.from(new Set([...sessions, ...fromOutput]))
}

function delegationDescription(event: OtelTraceEvent, childSessionId?: string): string {
  const explicit = cleanText(firstContent(attr(event, 'qwenpaw.delegation.description')))
  if (explicit) return explicit
  const parsed = parseStructuredValue(attr(event, 'tool.input', 'input.value'))
  if (parsed && typeof parsed === 'object') {
    const batch = parseStructuredValue(parsed.batch)
    if (Array.isArray(batch) && childSessionId) {
      const index = delegationChildren(event).indexOf(childSessionId)
      const item = index >= 0 ? batch[index] : undefined
      const task = cleanText(firstContent(item?.task ?? item?.description ?? item?.prompt))
      if (task) return task
    }
    return cleanText(firstContent(parsed.task ?? parsed.text ?? parsed.description ?? parsed.prompt)) || ''
  }
  return ''
}

function delegationSubagentType(event: OtelTraceEvent, kind: string): string {
  const target = cleanText(firstContent(attr(event, 'qwenpaw.delegation.target_agent')))
  if (target) return target
  const parsed = parseStructuredValue(attr(event, 'tool.input', 'input.value'))
  if (parsed && typeof parsed === 'object') {
    const fromInput = cleanText(firstContent(parsed.to_agent ?? parsed.agent ?? parsed.subagent_type))
    if (fromInput) return fromInput
  }
  if (kind === 'fork') return 'fork subagent'
  if (kind === 'spawn') return 'subagent'
  if (kind === 'batch') return 'subagent'
  if (kind === 'chat_with_agent' || kind === 'submit_to_agent') return 'agent'
  return 'subagent'
}

function buildToolCalls(event: OtelTraceEvent): AnyObj[] {
  const kind = delegationKind(event)
  if (!kind) return [buildToolCall(event)]
  const childSessionIds = delegationChildren(event)
  const base = buildToolCall(event)
  const sessions = childSessionIds.length ? childSessionIds : [undefined]
  return sessions.map((childSessionId, index) => {
    const args = {
      subagent_session_id: childSessionId,
      subagent_type: delegationSubagentType(event, kind),
      description: delegationDescription(event, childSessionId),
      delegation_kind: kind,
    }
    return {
      ...base,
      id: index === 0 ? base.id : `${base.id}:${index}`,
      function: {
        name: 'task',
        arguments: JSON.stringify(args),
      },
    }
  })
}

function makeToolInteraction(args: {
  tool: OtelTraceEvent
  framework: string
  model?: string
  owner: AnyObj
}): AnyObj {
  const created = args.tool.startTimeMs || Date.parse(args.tool.receivedAt) || Date.now()
  const completed = eventEndMs(args.tool) || created
  return {
    ...args.owner,
    content: '',
    timestamp: toIso(created),
    timeInfo: { created: toIso(created), completed: toIso(completed) },
    traceId: args.tool.traceId,
    spanId: `${args.tool.spanId || 'tool'}:interaction`,
    parentSpanId: args.tool.parentSpanId,
    name: `tool.${String(attr(args.tool, 'tool.name') || args.tool.name || 'tool').replace(/^tool\./, '')}`,
    model: args.model,
    usage: { input_tokens: 0, output_tokens: 0, total: 0 },
    tool_calls: buildToolCalls(args.tool),
  }
}

function makeAssistantInteraction(args: {
  content: string
  llm: OtelTraceEvent
  framework: string
  usageEvents: OtelTraceEvent[]
  owner: AnyObj
}): AnyObj {
  const created = args.llm.startTimeMs || Date.parse(args.llm.receivedAt) || Date.now()
  const completed = eventEndMs(args.llm) || created
  const usage = usageFor(args.usageEvents)
  const error = firstContent(attr(args.llm, 'error.message', 'exception.message'))
  return {
    ...args.owner,
    content: args.content,
    timestamp: toIso(created),
    timeInfo: { created: toIso(created), completed: toIso(completed) },
    traceId: args.llm.traceId,
    spanId: args.llm.spanId,
    parentSpanId: args.llm.parentSpanId,
    name: args.llm.name,
    model: eventModel(args.llm),
    usage: {
      input: usage.input_tokens,
      output: usage.output_tokens,
      reasoning: usage.reasoning_tokens || undefined,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      reasoning_tokens: usage.reasoning_tokens || undefined,
      total: usage.total,
    },
    ...(error ? { error } : {}),
  }
}

function makeSubagentInteraction(args: {
  content: string
  event: OtelTraceEvent
  framework: string
}): AnyObj {
  const created = args.event.startTimeMs || Date.parse(args.event.receivedAt) || Date.now()
  const completed = eventEndMs(args.event) || created
  const owner = ownerFields(args.event, args.framework)
  return {
    ...owner,
    trace_synthetic: true,
    content: args.content,
    timestamp: toIso(created),
    timeInfo: { created: toIso(created), completed: toIso(completed) },
    traceId: args.event.traceId,
    spanId: args.event.spanId,
    parentSpanId: args.event.parentSpanId,
    name: args.event.name,
    status: attr(args.event, 'subagent.status') || 'success',
  }
}

function latestEventByEnd(events: OtelTraceEvent[]): OtelTraceEvent | undefined {
  return events.reduce<OtelTraceEvent | undefined>((latest, event) => {
    if (!latest) return event
    return eventEndMs(event) >= eventEndMs(latest) ? event : latest
  }, undefined)
}

export function aggregateQwenPawTraceEvents(
  sessionId: string,
  events: OtelTraceEvent[],
): ExecutionRecord | null {
  const ordered = events
    .filter((event) => event.sessionId === sessionId)
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0))
  if (!ordered.length) return null
  const visibleEvents = ordered.filter((event) => !isInternalTitleSpan(event))
  if (!visibleEvents.length) return null

  const framework = visibleEvents.find((event) => event.serviceName)?.serviceName || 'qwenpaw'
  const firstEvent = visibleEvents[0]
  const rootSessionId = firstContent(attr(firstEvent, 'qwenpaw.root_session_id')) || sessionId
  const agentRoots = visibleEvents.filter((event) => isAgentSpan(event) && !isSubagentSpan(event))
  const agent = latestEventByEnd(agentRoots)
  const llmEvents = visibleEvents.filter(isLlmSpan)
  const toolEvents = visibleEvents.filter(isToolSpan)
  const skillEvents = toolEvents.filter(isSkillSpan)
  const mcpEvents = toolEvents.filter(isMcpSpan)
  const cronEvent = visibleEvents.find(isCronSpan)
  const sessionEndEvent = latestEventByEnd(visibleEvents.filter(isSessionEndSpan))
  const rootAgentName = firstContent(
    attr(agent || firstEvent, 'qwenpaw.agent.name', 'agent.name'),
  ) || framework
  const queryEvent = visibleEvents.find((event) => !isSubagentSpan(event) && !isInternalTitleSpan(event) && inputText(event))
  const query = inputText(queryEvent) || PLACEHOLDER_QUERY

  const interactions: AnyObj[] = []
  const lastAssistantBySession = new Map<string, AnyObj>()
  const seenUserTurns = new Set<string>()

  const maybeAddRootUser = (event: OtelTraceEvent) => {
    if (isSubagentSpan(event) || isInternalTitleSpan(event)) return
    const content = inputText(event)
    if (!content) return
    const key = userTurnKey(event, content)
    if (seenUserTurns.has(key)) return
    seenUserTurns.add(key)
    interactions.push(makeUserInteraction({
      content,
      event,
      framework,
      owner: { role: 'assistant', agent: rootAgentName },
    }))
  }

  for (const event of visibleEvents) {
    maybeAddRootUser(event)

    if (isAgentSpan(event)) {
      const userInput = inputText(event)
      const systemPrompt = firstContent(attr(event, 'system.prompt', 'llm.system_prompt'))
      if (systemPrompt) {
        interactions.push(makeSystemInteraction({ content: systemPrompt, event, framework }))
      }
      if (isSubagentSpan(event)) {
        const content = outputText(event) || userInput || ''
        interactions.push(makeSubagentInteraction({ content, event, framework }))
        lastAssistantBySession.set(qwenpawSessionId(event), interactions[interactions.length - 1])
      }
      continue
    }

    if (isLlmSpan(event)) {
      const owner = ownerFields(event, framework)
      const content = outputText(event) || ''
      const interaction = makeAssistantInteraction({
        content,
        llm: event,
        framework,
        usageEvents: [event],
        owner,
      })
      interactions.push(interaction)
      lastAssistantBySession.set(qwenpawSessionId(event), interaction)
      continue
    }

    if (isToolSpan(event)) {
      const owner = ownerFields(event, framework)
      const host = lastAssistantBySession.get(qwenpawSessionId(event)) ||
        [...interactions].reverse().find((interaction) =>
          interaction.role === 'assistant' && !interaction.tool_calls)
      if (host) {
        const calls = buildToolCalls(event)
        host.tool_calls = Array.isArray(host.tool_calls) ? [...host.tool_calls, ...calls] : calls
      } else {
        interactions.push(makeToolInteraction({ tool: event, framework, owner }))
      }
    }
  }

  if (!interactions.length && !agent && !llmEvents.length) return null

  interactions.sort((a, b) => {
    const at = Date.parse(a.timestamp || '') || 0
    const bt = Date.parse(b.timestamp || '') || 0
    return at - bt
  })
  const rootUserIndex = interactions.findIndex((interaction) =>
    interaction.role === 'user' && !interaction.subagent_session_id)
  if (rootUserIndex > 0) {
    interactions.unshift(interactions.splice(rootUserIndex, 1)[0])
  }

  const usageEvents = llmEvents.length
    ? llmEvents
    : agent
      ? [agent]
      : visibleEvents.filter((event) => tokenTotal(event) > 0)
  const usage = usageFor(usageEvents)
  const traceCompletedAt = sessionEndEvent
    ? toIso(
        (() => {
          const explicit = firstContent(attr(sessionEndEvent, 'qwenpaw.completed_at'))
          if (explicit) {
            const parsed = Date.parse(explicit)
            if (Number.isFinite(parsed)) return parsed
          }
          return eventEndMs(sessionEndEvent) || sessionEndEvent.startTimeMs || Date.now()
        })(),
      )
    : undefined
  const lastAssistant = [...interactions].reverse().find((interaction) =>
    interaction.role === 'assistant' && String(interaction.content || '').trim())
  const lastSubagent = [...interactions].reverse().find((interaction) =>
    interaction.role === 'subagent' && String(interaction.content || '').trim())
  const finalResult = lastAssistant?.content || lastSubagent?.content || outputText(agent) || ''
  const latency = agent?.latencyMs ||
    Math.max(
      ...visibleEvents.map((event) => eventEndMs(event)),
      ...visibleEvents.map((event) => event.startTimeMs || 0),
    ) - (firstEvent.startTimeMs || 0)
  const model = llmEvents.map(eventModel).find(Boolean) || (agent ? eventModel(agent) : undefined) || 'unknown'
  const invokedSkills = skillEvents
    .map((event) => {
      const name = String(attr(event, 'skill.name') || '').trim()
      if (!name) return undefined
      const version = attr(event, 'skill.version')
      const numericVersion = version === undefined || version === null || version === ''
        ? null
        : Number(version)
      return {
        name,
        version: Number.isFinite(numericVersion as number) ? (numericVersion as number) : null,
      }
    })
    .filter((skill): skill is { name: string; version: number | null } => Boolean(skill))
  const agentNames = Array.from(new Set(
    visibleEvents
      .filter(isAgentSpan)
      .map((event) => firstContent(attr(event, 'qwenpaw.agent.name', 'agent.name')))
      .filter(Boolean) as string[],
  ))

  return {
    task_id: sessionId,
    query,
    framework,
    model,
    tokens: usage.total,
    latency,
    final_result: finalResult,
    timestamp: new Date(firstEvent.startTimeMs || Date.parse(firstEvent.receivedAt) || Date.now()),
    label: framework,
    user: firstEvent.user || attr(firstEvent, 'qwenpaw.user_id', 'user.id') || 'anonymous',
    ...(traceCompletedAt ? { trace_completed_at: traceCompletedAt } : {}),
    interactions,
    agent: rootAgentName,
    agentName: rootAgentName,
    llm_call_count: llmEvents.length,
    tool_call_count: toolEvents.length,
    tool_call_error_count: toolEvents.filter((event) => {
      const status = String(attr(event, 'tool.status', 'tool.outcome') || '').toLowerCase()
      return status === 'error' || status === 'failed' || attr(event, 'error.message') !== undefined
    }).length,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    reasoning_tokens: usage.reasoning_tokens || undefined,
    force_query_update: true,
    session_merge_strategy: 'snapshot-replace',
    ...(invokedSkills.length ? { invokedSkills } : {}),
    ...(agentNames.length ? { agents: agentNames } : {}),
    // AC32: count distinct sub-agent sessions. LLM/tool spans owned by a
    // sub-agent session also carry role 'subagent', so dedupe by session id.
    subagentCount: new Set(
      interactions
        .filter((interaction) => interaction.role === 'subagent')
        .map((interaction) => interaction.subagent_session_id)
        .filter(Boolean),
    ).size,
    qwenpaw: {
      root_session_id: rootSessionId,
      agent_id: attr(agent || firstEvent, 'qwenpaw.agent_id') || '',
      channel: attr(firstEvent, 'qwenpaw.channel', 'channel') || '',
      source: attr(firstEvent, 'qwenpaw.source') || '',
      mcp_call_count: mcpEvents.length,
      skill_names: invokedSkills.map((skill) => skill.name),
      ...(cronEvent
        ? {
            cron_job_id: attr(cronEvent, 'cron.job_id'),
            cron_job_name: attr(cronEvent, 'cron.job_name'),
            cron_trigger: attr(cronEvent, 'cron.trigger'),
            cron_status: attr(cronEvent, 'cron.status'),
          }
        : {}),
    },
  }
}

export const qwenpawOtelTraceAdapter: OtelTraceAdapter = {
  id: 'qwenpaw',
  matches(events) {
    return events.some((event) =>
      event.serviceName === 'qwenpaw' ||
      event.attributes?.['agent.insight.framework'] === 'qwenpaw' ||
      event.attributes?.['qwenpaw.session_id'] !== undefined,
    )
  },
  aggregate: aggregateQwenPawTraceEvents,
}
