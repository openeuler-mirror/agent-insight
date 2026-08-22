import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '@/lib/ingest/otel/types';
import type { ClaudeOtelEvent } from '@/lib/ingest/claude-otel/types';
import type { OtelTraceAdapter } from './types';

const MAX_CONTENT_LENGTH = 2_000;
const TRUNCATION_MARKER = '…[truncated]';

/** Native Qwen OTLP bypasses the optional hook collector, so privacy and
 * payload limits must also be enforced at the server adapter boundary. */
export function protectQwenTraceContent(value: string): string {
  const redacted = value
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(
      /(["']?(?:api[-_]?key|authorization|cookie|password|secret|access[-_]?token|refresh[-_]?token)["']?\s*[:=]\s*["']?)([^\s,"'}]+)/gi,
      '$1[REDACTED]',
    );
  if (redacted.length <= MAX_CONTENT_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_CONTENT_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function content(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() ? protectQwenTraceContent(value) : undefined;
  try {
    return protectQwenTraceContent(JSON.stringify(value));
  } catch {
    return protectQwenTraceContent(String(value));
  }
}

function firstContent(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = content(value);
    if (text) return text;
  }
  return undefined;
}

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function iso(milliseconds: number): string {
  return new Date(milliseconds || Date.now()).toISOString();
}

function traceType(event: OtelTraceEvent): string {
  return String(event.attributes?.['agent.insight.trace_type'] || '').toLowerCase();
}

function nativeSpanType(event: OtelTraceEvent): 'agent' | 'llm' | 'tool' | 'subagent' | 'hook' | undefined {
  switch (String(event.name || '').toLowerCase()) {
    case 'qwen-code.interaction': return 'agent';
    case 'qwen-code.llm_request': return 'llm';
    case 'qwen-code.tool': return 'tool';
    case 'qwen-code.subagent': return 'subagent';
    case 'qwen-code.hook': return 'hook';
    default: return undefined;
  }
}

function isQwenNativeSpan(event: OtelTraceEvent): boolean {
  return String(event.name || '').toLowerCase().startsWith('qwen-code.');
}

function isQwenSideQuery(event: OtelTraceEvent): boolean {
  return String(event.attributes?.['qwen-code.prompt_id'] || '').startsWith('side-query:');
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function contentFromValue(value: unknown): string {
  const parsed = jsonValue(value);
  if (typeof parsed === 'string') return parsed;
  if (Array.isArray(parsed)) return parsed.map(contentFromValue).filter(Boolean).join('\n');
  if (!parsed || typeof parsed !== 'object') return '';
  const item = parsed as Record<string, unknown>;
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return contentFromValue(item.content);
  if (Array.isArray(item.parts)) return contentFromValue(item.parts);
  if (typeof item.output_text === 'string') return item.output_text;
  return '';
}

function userContentFromValue(value: unknown): string {
  const parsed = jsonValue(value);
  if (Array.isArray(parsed)) {
    const userMessage = [...parsed].reverse().find((item) =>
      item && typeof item === 'object' && (item as Record<string, unknown>).role === 'user',
    );
    if (userMessage && typeof userMessage === 'object') {
      const parts = (userMessage as Record<string, unknown>).parts;
      if (Array.isArray(parts)) {
        const explicitPrompt = parts
          .map(contentFromValue)
          .filter((part) => !part.trim().startsWith('<system-reminder>'))
          .join('\n');
        if (explicitPrompt) return explicitPrompt;
      }
      return contentFromValue(userMessage);
    }
    return contentFromValue(parsed);
  }
  return contentFromValue(parsed);
}

function firstAttributeContent(event: OtelTraceEvent | undefined, keys: string[]): string {
  if (!event) return '';
  for (const key of keys) {
    const content = contentFromValue(event.attributes?.[key]);
    if (content) return content;
  }
  return '';
}

export function isQwenCodeOtelEvent(event: OtelTraceEvent): boolean {
  return event.serviceName === 'qwencode'
    || event.serviceName === 'qwen-code'
    || event.attributes?.['agent.insight.framework'] === 'qwencode';
}

const QWENCODE_SESSION_PREFIX = 'qwencode:';

/**
 * Keep Qwen Code sessions in their own spool namespace. Different collectors
 * can legitimately generate the same raw session ID, while the shared OTLP
 * spool and consumer use sessionId as their aggregation key.
 */
export function isolateQwenCodeOtelEvent(event: OtelTraceEvent): OtelTraceEvent {
  if (!isQwenCodeOtelEvent(event)) return event;

  const rawSessionId = event.sessionId;
  return {
    ...event,
    sessionId: rawSessionId.startsWith(QWENCODE_SESSION_PREFIX)
      ? rawSessionId
      : `${QWENCODE_SESSION_PREFIX}${rawSessionId}`,
    attributes: {
      ...event.attributes,
      'qwen.session.id': event.attributes?.['qwen.session.id'] ?? rawSessionId,
    },
  };
}

/** Convert Qwen's native skill_launch OTLP log into the trace event consumed
 * by this adapter. Qwen emits skills as Logs (rather than Spans). */
export function qwenSkillLogToOtelEvent(event: ClaudeOtelEvent): OtelTraceEvent | null {
  const serviceName = String(event.resource?.['service.name'] || '');
  if (event.eventName !== 'qwen-code.skill_launch' || !['qwencode', 'qwen-code'].includes(serviceName)) return null;
  const attrs = event.attributes || {};
  const startedAt = Date.parse(event.eventTimestamp || event.receivedAt);
  const success = attrs.success !== false && String(attrs.success).toLowerCase() !== 'false';
  return isolateQwenCodeOtelEvent({
    receivedAt: event.receivedAt,
    sessionId: event.sessionId,
    traceId: event.traceId,
    spanId: event.spanId || `qwen-skill-${event.promptId || event.sequence || startedAt}`,
    name: 'qwen-code.skill',
    kind: 'tool',
    serviceName,
    user: event.user,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    latencyMs: 0,
    startTimeMs: Number.isFinite(startedAt) ? startedAt : Date.now(),
    attributes: {
      ...attrs,
      'agent.insight.framework': 'qwencode',
      'agent.insight.trace_type': 'skill',
      'skill.name': attrs.skill_name || attrs['skill.name'] || 'unknown',
      'skill.version': attrs.skill_version || attrs['skill.version'],
      'tool.status': success ? 'ok' : 'error',
      'tool.arguments': JSON.stringify({ skill: attrs.skill_name || attrs['skill.name'] || 'unknown' }),
      'tool.output': typeof event.body === 'string' ? event.body : undefined,
    },
  });
}

function isAgent(event: OtelTraceEvent): boolean {
  return nativeSpanType(event) === 'agent' || traceType(event) === 'agent' || (
    traceType(event) !== 'subagent' &&
    String(event.attributes?.['openinference.span.kind'] || '').toUpperCase() === 'AGENT'
  );
}

function isTool(event: OtelTraceEvent): boolean {
  // A native Qwen tool call has child hook/execution spans. Only the root
  // qwen-code.tool span owns the complete arguments and result; rendering its
  // children duplicates a call as empty 0ms/failed tools in the trace view.
  if (isQwenNativeSpan(event)) return nativeSpanType(event) === 'tool' && !isSkill(event);
  return traceType(event) !== 'skill' && (
    traceType(event) === 'tool' || event.kind === 'tool' || event.attributes?.['tool.name'] !== undefined
  );
}

function isSkill(event: OtelTraceEvent): boolean {
  return traceType(event) === 'skill' || (
    nativeSpanType(event) === 'tool' &&
    String(event.attributes?.['gen_ai.tool.name'] || event.attributes?.['tool.name'] || '').toLowerCase() === 'skill'
  );
}

function isLlm(event: OtelTraceEvent): boolean {
  const type = traceType(event);
  // Qwen emits explicit trace types for every first-party record. Prefer that
  // semantic type over the shared normalizer's degraded kind: unrecognized
  // hook spans are intentionally preserved there as kind=llm.
  if (isQwenNativeSpan(event)) return nativeSpanType(event) === 'llm' && !isQwenSideQuery(event);
  // Native Qwen also exports low-level HTTP spans named POST. They are
  // transport wrappers around qwen-code.llm_request, not additional model
  // calls, and must not extend the user-visible execution timeline.
  if (isQwenCodeOtelEvent(event) && !type) return false;
  if (type) return type === 'llm';
  return !isAgent(event) && event.kind === 'llm';
}

function isSubagent(event: OtelTraceEvent): boolean {
  return nativeSpanType(event) === 'subagent' || traceType(event) === 'subagent';
}

function normalizedSubagentType(value: string): string {
  return value.trim().split(/[^A-Za-z0-9_-]+/)[0]?.toLowerCase() || 'subagent';
}

function model(event: OtelTraceEvent | undefined): string | undefined {
  if (!event) return undefined;
  return firstContent(
    event.model,
    event.attributes?.['gen_ai.request.model'],
    event.attributes?.['llm.request.model'],
    event.attributes?.['llm.model_name'],
  );
}

function agentName(event: OtelTraceEvent | undefined): string {
  const explicitName = firstContent(
    event?.attributes?.['gen_ai.agent.name'],
    event?.attributes?.['qwen-code.agent.name'],
    event?.attributes?.['agent.name'],
  );
  if (explicitName) return explicitName;
  const serviceName = firstContent(event?.serviceName);
  // `qwencode` is Qwen's OTLP service.name, not an agent identity. Keep real
  // agent names when exported, but present the root product agent canonically.
  if (!serviceName || ['qwencode', 'qwen-code'].includes(serviceName.toLowerCase())) return 'qwen-code';
  return serviceName;
}

function toolInteraction(event: OtelTraceEvent, selectedModel: string | undefined) {
  const attrs = event.attributes || {};
  const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completedAt = eventEndMs(event) || startedAt;
  const status = String(attrs['tool.status'] || '').toLowerCase();
  const error = firstContent(attrs['error.message'], attrs['exception.message'], attrs.error);
  const failed = status === 'error'
    || status === 'failed'
    || attrs.success === false
    || String(attrs.success).toLowerCase() === 'false'
    || !!attrs['tool.failure_kind']
    || !!error;
  const output = firstContent(attrs['tool.output'], attrs['output.value'], attrs['tool.result'], attrs['gen_ai.tool.call.result']);

  return {
    // Tool calls are represented by the structured tool_calls field below.  Do
    // not mark this synthetic interaction as an assistant turn, otherwise the
    // trace view incorrectly counts it as an additional LLM response.
    role: 'tool',
    content: '',
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    name: event.name,
    agent: agentName(event),
    model: selectedModel,
    timestamp: iso(startedAt),
    timeInfo: { created: iso(startedAt), completed: iso(completedAt) },
    tool_calls: [{
      id: event.spanId,
      type: 'function',
      state: failed ? 'error' : 'success',
      function: {
        name: String(attrs['tool.name'] || attrs['gen_ai.tool.name'] || event.name || 'tool').replace(/^tool\./, ''),
        arguments: firstContent(attrs['tool.arguments'], attrs['input.value'], attrs['gen_ai.tool.call.arguments']) || '{}',
      },
      output,
      result: output,
      timing: { started_at: iso(startedAt), completed_at: iso(completedAt) },
    }],
    ...(error ? { status: 'error', error: { message: error } } : {}),
  };
}

function skillInteraction(event: OtelTraceEvent, selectedModel: string | undefined) {
  const attrs = event.attributes || {};
  const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completedAt = eventEndMs(event) || startedAt;
  const status = String(attrs['tool.status'] || '').toLowerCase();
  const error = firstContent(attrs['error.message'], attrs['exception.message']);
  const failed = status === 'error'
    || status === 'failed'
    || attrs.success === false
    || String(attrs.success).toLowerCase() === 'false'
    || !!attrs['tool.failure_kind']
    || !!error;
  const output = firstContent(attrs['tool.output'], attrs['output.value'], attrs['tool.result'], attrs['gen_ai.tool.call.result']);
  const rawArguments = firstContent(attrs['tool.arguments'], attrs['input.value'], attrs['gen_ai.tool.call.arguments']);
  const parsedArguments = jsonValue(rawArguments);
  const skillName = firstContent(attrs['skill.name'], (parsedArguments as Record<string, unknown> | undefined)?.skill) || 'unknown';
  const version = firstContent(attrs['skill.version']);
  const triggerMode = firstContent(attrs['skill.trigger_mode']) || 'tool';
  let args = rawArguments;
  if (!args) {
    args = JSON.stringify({ skill: skillName, ...(version ? { version } : {}), triggerMode });
  }

  return {
    role: 'tool',
    content: '',
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    name: event.name,
    agent: agentName(event),
    model: selectedModel,
    timestamp: iso(startedAt),
    timeInfo: { created: iso(startedAt), completed: iso(completedAt) },
    tool_calls: [{
      id: event.spanId,
      type: 'function',
      state: failed ? 'error' : 'success',
      function: { name: 'skill', arguments: args },
      output,
      result: output,
      timing: { started_at: iso(startedAt), completed_at: iso(completedAt) },
    }],
    ...(error ? { status: 'error', error: { message: error } } : {}),
  };
}

type SubagentOwner = {
  id: string;
  name: string;
};

function llmInteraction(
  event: OtelTraceEvent,
  selectedModel: string | undefined,
  subagentOwner?: SubagentOwner,
) {
  const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completedAt = eventEndMs(event) || startedAt;
  const attrs = event.attributes || {};
  return {
    // Native Qwen subagent LLM spans use the subagent invocation's traceId.
    // Preserve that ownership in the shared interaction contract so the tree
    // builder charges latency and tokens to the child rather than the root.
    role: subagentOwner ? 'subagent' : 'assistant',
    content: firstContent(attrs['output.value'], firstAttributeContent(event, ['gen_ai.output.messages', 'gen_ai.output.message'])) || '',
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    name: event.name,
    agent: subagentOwner?.name || agentName(event),
    ...(subagentOwner ? {
      subagent_name: subagentOwner.name,
      subagent_session_id: subagentOwner.id,
    } : {}),
    model: model(event) || selectedModel,
    provider: firstContent(attrs['gen_ai.provider.name']),
    timestamp: iso(startedAt),
    timeInfo: { created: iso(startedAt), completed: iso(completedAt) },
    usage: {
      input: event.usage?.input_tokens || 0,
      output: event.usage?.output_tokens || 0,
      reasoning: event.usage?.reasoning_tokens || 0,
      total: event.usage?.total_tokens || 0,
      cache: {
        read: Number(attrs['gen_ai.usage.cache_read_input_tokens']) || 0,
      },
    },
  };
}

export function aggregateQwenCodeTraceEvents(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null {
  // A client can crash after the server accepts a batch but before local spool
  // files are moved to uploaded/. Retrying that batch must not duplicate Tool,
  // Skill or LLM rows. Root snapshots intentionally reuse their span ID, so
  // the newest copy also replaces the older running snapshot here.
  const uniqueEvents = new Map<string, OtelTraceEvent>();
  for (const event of events.filter((item) =>
    item.sessionId === sessionId && isQwenCodeOtelEvent(item)
  )) {
    uniqueEvents.set(`${event.traceId}:${event.spanId}`, event);
  }
  const ordered = [...uniqueEvents.values()]
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  if (!ordered.length) return null;

  // Stop hooks emit a running snapshot and SessionEnd emits the final snapshot
  // with the same root span. Prefer the newest one so result/latency advance
  // without waiting for process exit.
  const agentEvents = ordered.filter(isAgent);
  const nativeAgentEvents = agentEvents.filter((event) => nativeSpanType(event) === 'agent');
  // A native Qwen session can emit several interaction spans while one user
  // task waits for subagents or resumes after background work. The session
  // execution starts at the first interaction; choosing the last one reduces
  // a minute-long trace to only its final few seconds. Legacy snapshot spans
  // still use the newest copy as before.
  const agent = nativeAgentEvents[0] || agentEvents.at(-1);
  const tools = ordered.filter(isTool);
  const skills = ordered.filter(isSkill);
  const llmCalls = ordered.filter(isLlm);
  // Forks and Team members emit an immediate running snapshot, followed by a
  // completed span. OTLP stores spans immutably, so use agent.id to collapse
  // those two physical spans into one logical agent and prefer the later end.
  const subagentById = new Map<string, OtelTraceEvent>();
  for (const event of ordered.filter(isSubagent)) {
    // The OTLP parser permits a missing spanId on malformed input.  Keep the
    // aggregation total (and the Map key typed as string) by falling back to
    // a deterministic per-event key instead of failing the whole batch.
    const agentId = firstContent(event.attributes?.['agent.id'], event.attributes?.['qwen-code.subagent.id']) || event.spanId || `subagent-${event.startTimeMs ?? 0}`;
    const current = subagentById.get(agentId);
    if (!current || eventEndMs(event) >= eventEndMs(current)) subagentById.set(agentId, event);
  }
  const subagents = [...subagentById.values()];
  const nativeSubagentOwnersByTraceId = new Map<string, SubagentOwner>();
  for (const subagent of subagents.filter((event) => nativeSpanType(event) === 'subagent')) {
    if (!subagent.traceId) continue;
    const attrs = subagent.attributes || {};
    const id = firstContent(attrs['agent.id'], attrs['qwen-code.subagent.id']) || subagent.spanId || 'subagent';
    const name = firstContent(attrs['agent.name'], attrs['qwen-code.subagent.name'], attrs['gen_ai.agent.name'])
      || firstContent(attrs['agent.type'])
      || 'subagent';
    nativeSubagentOwnersByTraceId.set(subagent.traceId, { id, name });
  }
  const selectedModel = model(agent) || ordered.map(model).find(Boolean) || 'unknown';
  const rootAgentName = agentName(agent);
  const query = firstContent(
    agent?.attributes?.['input.value'],
    agent?.attributes?.['gen_ai.prompt'],
    userContentFromValue(llmCalls[0]?.attributes?.['gen_ai.input.messages']) ||
      firstAttributeContent(llmCalls[0], ['gen_ai.input.message']),
  ) || 'Qwen Code Session';
  const finalResult = firstContent(
    agent?.attributes?.['output.value'],
    agent?.attributes?.['gen_ai.completion'],
    firstAttributeContent(llmCalls.at(-1), ['gen_ai.output.messages', 'gen_ai.output.message']),
  ) || '';
  const startTimeMs = agent?.startTimeMs || ordered[0].startTimeMs || Date.now();
  const semanticEvents = [...agentEvents, ...llmCalls, ...skills, ...tools, ...subagents];
  const endTimeMs = Math.max(startTimeMs, ...semanticEvents.map(eventEndMs));
  const usageEvents = [...llmCalls, ...subagents];
  const inputTokens = usageEvents.reduce((sum, event) => sum + (event.usage?.input_tokens || 0), 0);
  const outputTokens = usageEvents.reduce((sum, event) => sum + (event.usage?.output_tokens || 0), 0);
  const reasoningTokens = usageEvents.reduce((sum, event) => sum + (event.usage?.reasoning_tokens || 0), 0);

  const interactions: Record<string, unknown>[] = [{
    role: 'user',
    content: query,
    traceId: agent?.traceId,
    spanId: agent?.spanId ? `${agent.spanId}:input` : undefined,
    timestamp: iso(startTimeMs),
    timeInfo: { created: iso(startTimeMs), completed: iso(startTimeMs) },
    agent: rootAgentName,
  }];
  const subagentTypes = new Map(
    subagents.map((event) => {
      const attrs = event.attributes || {};
      return [
        firstContent(attrs['agent.id'], attrs['qwen-code.subagent.id']) || event.spanId || 'subagent',
        firstContent(attrs['agent.name'], attrs['qwen-code.subagent.name'], attrs['gen_ai.agent.name']) || firstContent(attrs['agent.type']) || 'subagent',
      ];
    }),
  );
  for (const subagent of subagents) {
    const attrs = subagent.attributes || {};
    const agentId = firstContent(attrs['agent.id'], attrs['qwen-code.subagent.id']) || subagent.spanId || 'subagent';
    const agentType = firstContent(attrs['agent.type'], attrs['qwen-code.subagent.invocation_kind']) || 'subagent';
    const agentName = firstContent(attrs['agent.name'], attrs['qwen-code.subagent.name'], attrs['gen_ai.agent.name']) || agentType;
    const parentAgentId = firstContent(attrs['agent.parent_id']);
    const parentAgentType = parentAgentId ? (subagentTypes.get(parentAgentId) || 'subagent') : null;
    // Team members are named roles (for example `explorer` and `reviewer`)
    // while their reusable implementation can share one Qwen type (`Explore`).
    // The call-tree matcher therefore keys on the member name when available.
    const subagentType = normalizedSubagentType(agentName);
    const startedAt = subagent.startTimeMs || startTimeMs;
    const completedAt = eventEndMs(subagent) || startedAt;
    interactions.push({
      // A nested Qwen subagent is delegated by its parent, not by the root.
      // Encode that task call in the parent's session slice so the generic
      // Agent Insight tree builder can attach three-or-more levels correctly.
      role: parentAgentId ? 'subagent' : 'assistant',
      content: '',
      agent: parentAgentType || rootAgentName,
      ...(parentAgentId ? { subagent_name: parentAgentType, subagent_session_id: parentAgentId } : {}),
      timestamp: iso(startedAt),
      timeInfo: { created: iso(startedAt), completed: iso(startedAt) },
      tool_calls: [{
        id: subagent.spanId,
        type: 'function',
        function: { name: 'task', arguments: JSON.stringify({ subagent_session_id: agentId, subagent_type: subagentType, subagent_role: agentType }) },
      }],
    });
    interactions.push({
      role: 'subagent',
      content: firstContent(attrs['output.value'], firstAttributeContent(subagent, ['gen_ai.output.messages', 'gen_ai.output.message'])) || '',
      agent: agentName,
      subagent_name: agentName,
      subagent_session_id: agentId,
      team_id: firstContent(attrs['team.id']) || undefined,
      team_name: firstContent(attrs['team.name']) || undefined,
      fork: (firstContent(attrs['agent.fork']) === 'true' || attrs['qwen-code.subagent.invocation_kind'] === 'fork') || undefined,
      forked_from_session_id: firstContent(attrs['agent.forked_from_session_id']) || undefined,
      timestamp: iso(startedAt),
      timeInfo: { created: iso(startedAt), completed: iso(completedAt) },
      usage: {
        input: subagent.usage?.input_tokens || 0,
        output: subagent.usage?.output_tokens || 0,
        reasoning: subagent.usage?.reasoning_tokens || 0,
        total: subagent.usage?.total_tokens || 0,
      },
    });
  }
  interactions.push(...llmCalls.map((event) => llmInteraction(
    event,
    selectedModel,
    event.attributes?.subagent_name && event.traceId
      ? nativeSubagentOwnersByTraceId.get(event.traceId)
      : undefined,
  )));
  interactions.push(...skills.map((event) => skillInteraction(event, selectedModel)));
  interactions.push(...tools.map((event) => toolInteraction(event, selectedModel)));
  if (finalResult) {
    interactions.push({
      role: 'assistant',
      content: finalResult,
      traceId: agent?.traceId,
      spanId: agent?.spanId ? `${agent.spanId}:output` : undefined,
      timestamp: iso(endTimeMs),
      timeInfo: { created: iso(endTimeMs), completed: iso(endTimeMs) },
      agent: rootAgentName,
      model: selectedModel,
    });
  }

  // OTLP batches are grouped by instrumentation scope rather than by the
  // order in which Qwen executed them.  Keep the synthetic user input first,
  // then order every LLM, Tool, Skill and Subagent interaction by its span
  // start time so the trace UI reflects the actual execution timeline.
  const [userInteraction, ...timeline] = interactions;
  timeline.sort((left, right) => {
    const leftTime = Date.parse(String((left.timeInfo as Record<string, unknown> | undefined)?.created || left.timestamp || 0));
    const rightTime = Date.parse(String((right.timeInfo as Record<string, unknown> | undefined)?.created || right.timestamp || 0));
    return leftTime - rightTime;
  });
  interactions.splice(0, interactions.length, ...(userInteraction ? [userInteraction, ...timeline] : timeline));

  return {
    task_id: sessionId,
    // The OTLP ingest route authenticates the request and attaches the owner to
    // every normalized event. Preserve it when materializing the Execution row,
    // otherwise the trace page's user-scope query cannot see Qwen Code traces.
    user: ordered.find((event) => event.user)?.user || 'anonymous',
    query,
    framework: 'qwencode',
    model: selectedModel,
    tokens: inputTokens + outputTokens + reasoningTokens,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens || undefined,
    latency: Math.max(0, endTimeMs - startTimeMs) / 1000,
    // A Qwen CLI session can contain many user turns and every Stop hook
    // refreshes the same Execution row. Use the latest snapshot time for the
    // trace list's "execution time" and sorting; the real session start is
    // still preserved by the first interaction and is used for latency.
    timestamp: new Date(endTimeMs),
    trace_completed_at: iso(endTimeMs),
    final_result: finalResult,
    label: 'qwencode',
    agent: rootAgentName,
    agentName: rootAgentName,
    tool_call_count: tools.length,
    tool_call_error_count: tools.filter((event) => {
      const attrs = event.attributes || {};
      return String(attrs['tool.status'] || '').toLowerCase() === 'error' || attrs['error.message'] !== undefined;
    }).length,
    llm_call_count: llmCalls.length + subagents.reduce((sum, event) => sum + (Number(event.attributes?.['agent.llm_call_count']) || 0), 0),
    interactions,
  };
}

export const qwenCodeOtelTraceAdapter: OtelTraceAdapter = {
  id: 'qwencode',
  matches: (events) => events.some(isQwenCodeOtelEvent),
  aggregate: aggregateQwenCodeTraceEvents,
};
