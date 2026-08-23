import type { ExecutionRecord } from '@/lib/storage/data-service'
import type { OtelTraceEvent } from '../types'
import type { OtelTraceAdapter } from './types'

type AnyObj = Record<string, any>

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString()
}

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0)
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
  return (
    attr(event, 'qwenpaw.parent_session_id', 'subagent.session.id', 'subagent.parent.session.id') !== undefined ||
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

function latestUserMessage(value: string | undefined): string | undefined {
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : undefined
  const messages = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.messages)
      ? parsed.messages
      : undefined
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (String(message?.role || '').toLowerCase() !== 'user') continue
    const text = stringifyMessageContent(message.content)
    if (text.trim()) return text
  }
  return undefined
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
  const raw = firstContent(attr(event, 'input.value'))
  return latestUserMessage(raw) || raw
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
  const sessionId = firstContent(attr(event, 'qwenpaw.session_id')) || event.sessionId
  const parentSessionId = firstContent(attr(event, 'qwenpaw.parent_session_id'))
  if (isSubagentSpan(event) || parentSessionId) {
    return {
      role: 'subagent',
      agent: agentName,
      subagent_name: agentName,
      subagent_session_id: firstContent(attr(event, 'subagent.session.id')) || sessionId,
    }
  }
  return { role: 'assistant', agent: agentName }
}

function makeUserInteraction(args: {
  content: string
  event: OtelTraceEvent
  framework: string
}): AnyObj {
  const created = args.event.startTimeMs || Date.parse(args.event.receivedAt) || Date.now()
  const owner = ownerFields(args.event, args.framework)
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
    tool_calls: [buildToolCall(args.tool)],
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

  const framework = ordered.find((event) => event.serviceName)?.serviceName || 'qwenpaw'
  const rootSessionId = firstContent(attr(ordered[0], 'qwenpaw.root_session_id')) || sessionId
  const agentRoots = ordered.filter((event) => isAgentSpan(event) && !isSubagentSpan(event))
  const agent = latestEventByEnd(agentRoots)
  const llmEvents = ordered.filter(isLlmSpan)
  const toolEvents = ordered.filter(isToolSpan)
  const skillEvents = toolEvents.filter(isSkillSpan)
  const mcpEvents = toolEvents.filter(isMcpSpan)
  const cronEvent = ordered.find(isCronSpan)
  const sessionEndEvent = ordered.find(isSessionEndSpan)

  const interactions: AnyObj[] = []
  const lastAssistantBySession = new Map<string, AnyObj>()

  for (const event of ordered) {
    if (isAgentSpan(event)) {
      const owner = ownerFields(event, framework)
      const userInput = inputText(event)
      if (userInput) {
        interactions.push(makeUserInteraction({ content: userInput, event, framework }))
      }
      const systemPrompt = firstContent(attr(event, 'system.prompt', 'llm.system_prompt'))
      if (systemPrompt) {
        interactions.push(makeSystemInteraction({ content: systemPrompt, event, framework }))
      }
      if (isSubagentSpan(event)) {
        const content = outputText(event) || userInput || ''
        interactions.push(makeSubagentInteraction({ content, event, framework }))
        lastAssistantBySession.set(event.sessionId, interactions[interactions.length - 1])
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
      lastAssistantBySession.set(event.sessionId, interaction)
      continue
    }

    if (isToolSpan(event)) {
      const owner = ownerFields(event, framework)
      const host = lastAssistantBySession.get(event.sessionId) ||
        [...interactions].reverse().find((interaction) =>
          interaction.role === 'assistant' && !interaction.tool_calls)
      if (host) {
        host.tool_calls = Array.isArray(host.tool_calls) ? [...host.tool_calls, buildToolCall(event)] : [buildToolCall(event)]
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

  const usageEvents = llmEvents.length
    ? llmEvents
    : agent
      ? [agent]
      : ordered.filter((event) => tokenTotal(event) > 0)
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
  const firstEvent = ordered[0]
  const firstUser = interactions.find((interaction) => interaction.role === 'user' && String(interaction.content || '').trim())
  const lastAssistant = [...interactions].reverse().find((interaction) =>
    interaction.role === 'assistant' && String(interaction.content || '').trim())
  const lastSubagent = [...interactions].reverse().find((interaction) =>
    interaction.role === 'subagent' && String(interaction.content || '').trim())
  const finalResult = lastAssistant?.content || lastSubagent?.content || outputText(agent) || ''
  const latency = agent?.latencyMs ||
    Math.max(
      ...ordered.map((event) => eventEndMs(event)),
      ...ordered.map((event) => event.startTimeMs || 0),
    ) - (ordered[0]?.startTimeMs || 0)
  const model = llmEvents.map(eventModel).find(Boolean) || (agent ? eventModel(agent) : undefined) || 'unknown'
  const rootAgentName = firstContent(
    attr(agent || ordered[0], 'qwenpaw.agent.name', 'agent.name'),
  ) || framework
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
    ordered
      .filter(isAgentSpan)
      .map((event) => firstContent(attr(event, 'qwenpaw.agent.name', 'agent.name')))
      .filter(Boolean) as string[],
  ))

  return {
    task_id: sessionId,
    query: firstUser?.content || 'QwenPaw Session',
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
