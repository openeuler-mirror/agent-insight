import fs from 'node:fs';
import type { ExecutionRecord } from '@/lib/storage/data-service';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { readClaudeOtelEventsForSession } from './spool';
import type { ClaudeOtelAggregationResult, ClaudeOtelEvent } from './types';

const ROOT_AGENT_NAME = 'Claude Code';

function asNumber(value: any, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asTokenNumber(value: any, fallback = 0): number {
  return Math.max(0, asNumber(value, fallback));
}

function asString(value: any): string {
  return typeof value === 'string' ? value : '';
}

function eventTime(event: ClaudeOtelEvent): string {
  return event.eventTimestamp || event.receivedAt || new Date().toISOString();
}

function eventSortValue(event: ClaudeOtelEvent): number {
  const t = Date.parse(eventTime(event));
  const time = Number.isFinite(t) ? t : 0;
  return time * 1000 + (event.sequence || 0);
}

function eventKey(event: ClaudeOtelEvent): string {
  return [
    event.sessionId,
    event.promptId || '',
    event.sequence ?? '',
    event.eventName,
    event.eventTimestamp || '',
    event.spanId || '',
  ].join('|');
}

function promptKey(event: ClaudeOtelEvent): string {
  return event.promptId || '__session__';
}

function toIsoTimestamp(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function toMsTimestamp(value: any): number | undefined {
  if (value == null) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return undefined;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) ? (n > 0 && n < 10_000_000_000 ? n * 1000 : n) : undefined;
    }
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function parseJsonMaybe(value: any): any {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readBodyPayload(attrs: Record<string, any>): any {
  const inline = parseJsonMaybe(attrs.body);
  if (inline) return inline;

  const bodyRef = typeof attrs.body_ref === 'string' ? attrs.body_ref : '';
  if (!bodyRef) return null;
  try {
    if (!fs.existsSync(bodyRef)) return null;
    const text = fs.readFileSync(bodyRef, 'utf8');
    return parseJsonMaybe(text);
  } catch {
    return null;
  }
}

function textFromContent(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const chunks: string[] = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') chunks.push(block);
    else if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
  }
  return chunks.join('');
}

function contentBlocksFromResponseBody(body: any): any[] {
  const content = body?.content;
  return Array.isArray(content) ? content : [];
}

function normalizeUsage(bodyUsage: any, attrs: Record<string, any> = {}): any {
  const input = asTokenNumber(attrs.input_tokens !== undefined && attrs.input_tokens !== '' ? attrs.input_tokens : bodyUsage?.input_tokens ?? bodyUsage?.input);
  const output = asTokenNumber(attrs.output_tokens !== undefined && attrs.output_tokens !== '' ? attrs.output_tokens : bodyUsage?.output_tokens ?? bodyUsage?.output);
  const cacheRead = asTokenNumber(attrs.cache_read_tokens !== undefined && attrs.cache_read_tokens !== '' ? attrs.cache_read_tokens : bodyUsage?.cache_read_input_tokens ?? bodyUsage?.cache_read_tokens);
  const cacheWrite = asTokenNumber(attrs.cache_creation_tokens !== undefined && attrs.cache_creation_tokens !== '' ? attrs.cache_creation_tokens : bodyUsage?.cache_creation_input_tokens ?? bodyUsage?.cache_creation_tokens);
  const rawTotal = asTokenNumber(bodyUsage?.total_tokens ?? bodyUsage?.total);
  const total = Math.max(rawTotal, input + output + cacheRead + cacheWrite);
  return {
    total,
    total_tokens: total,
    input,
    output,
    input_tokens: input,
    output_tokens: output,
    cache: { read: cacheRead, write: cacheWrite },
  };
}

function interactionTimeInfo(requestEvent: ClaudeOtelEvent | undefined, responseEvent: ClaudeOtelEvent): any {
  const attrs = requestEvent?.attributes || {};
  const startMs = toMsTimestamp(requestEvent ? eventTime(requestEvent) : eventTime(responseEvent));
  const duration = asNumber(attrs.duration_ms);
  const completedMs = startMs != null && duration > 0 ? startMs + duration : toMsTimestamp(eventTime(responseEvent));
  return {
    created: toIsoTimestamp(startMs) || eventTime(responseEvent),
    completed: toIsoTimestamp(completedMs),
  };
}

function toolTimingFromResult(event: ClaudeOtelEvent): any {
  const duration = asNumber(event.attributes?.duration_ms);
  const completedMs = toMsTimestamp(eventTime(event));
  const startedMs = completedMs != null && duration > 0 ? completedMs - duration : undefined;
  return {
    started_at: toIsoTimestamp(startedMs),
    completed_at: toIsoTimestamp(completedMs),
  };
}

function normalizeToolName(name: any): string {
  const raw = typeof name === 'string' ? name : 'tool';
  return raw.toLowerCase() === 'agent' ? 'task' : raw;
}

function normalizeSubagentType(value: any): string {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : 'agent';
  return raw.toLowerCase();
}

function buildToolCallFromToolUse(block: any): any {
  const toolInput = { ...(block?.input || {}) };
  if (block?.name === 'Agent' && !toolInput.subagent_type && !toolInput.subagentType) {
    toolInput.subagent_type = normalizeSubagentType(undefined);
  }
  return {
    id: block?.id,
    type: 'function',
    function: {
      name: normalizeToolName(block?.name),
      arguments: JSON.stringify(toolInput || {}),
    },
    name: normalizeToolName(block?.name),
    raw_name: block?.name,
    arguments: JSON.stringify(toolInput || {}),
    trace_split_parallel_task: block?.name === 'Agent',
    state: 'pending',
  };
}

function buildToolCallFromResult(event: ClaudeOtelEvent, toolUse?: any, output?: any): any {
  const attrs = event.attributes || {};
  const rawParams = parseJsonMaybe(attrs.tool_parameters);
  const rawInput = parseJsonMaybe(attrs.tool_input);
  const toolInput = { ...((toolUse?.input || rawInput || rawParams || {}) as Record<string, any>) };
  const name = normalizeToolName(toolUse?.name || attrs.tool_name || 'tool');
  if ((toolUse?.name || attrs.tool_name) === 'Agent' && !toolInput.subagent_type && !toolInput.subagentType) {
    toolInput.subagent_type = normalizeSubagentType(undefined);
  }
  return {
    id: attrs.tool_use_id,
    type: 'function',
    function: {
      name,
      arguments: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {}),
    },
    name,
    raw_name: toolUse?.name || attrs.tool_name,
    arguments: typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput || {}),
    trace_split_parallel_task: (toolUse?.name || attrs.tool_name) === 'Agent',
    state: String(attrs.success) === 'false' ? 'error' : 'success',
    timing: toolTimingFromResult(event),
    duration_ms: asNumber(attrs.duration_ms),
    decision_type: attrs.decision_type,
    decision_source: attrs.decision_source,
    output_size_bytes: asNumber(attrs.tool_result_size_bytes),
    error_type: attrs.error_type,
    error: attrs.error,
    output,
  };
}

function mergeToolCall(existing: any, incoming: any): any {
  const merged = { ...existing, ...incoming };
  if (existing.function || incoming.function) {
    merged.function = { ...(existing.function || {}), ...(incoming.function || {}) };
  }
  if (existing.name === 'task' && incoming.raw_name === 'Agent') {
    merged.name = 'task';
    merged.function = { ...(merged.function || {}), name: 'task' };
  }
  return merged;
}

function toolUseBlocks(content: any[]): any[] {
  return content.filter((block) => block?.type === 'tool_use' && block.id);
}

function hasToolUse(content: any[]): boolean {
  return toolUseBlocks(content).length > 0;
}

function subagentNameFromToolUse(toolUse: any): string {
  const input = toolUse?.input || {};
  if (toolUse?.name === 'Agent') return normalizeSubagentType(input.subagent_type || input.subagentType);
  return input.subagent_type || input.subagentType || toolUse?.name || 'Subagent';
}

function dedupeEvents(events: ClaudeOtelEvent[]): ClaudeOtelEvent[] {
  const seen = new Set<string>();
  const out: ClaudeOtelEvent[] = [];
  for (const event of events) {
    const key = [
      event.sessionId,
      event.promptId || '',
      event.sequence ?? '',
      event.eventName,
      event.eventTimestamp || '',
      event.spanId || '',
      event.attributes?.request_id || '',
      event.attributes?.tool_use_id || '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function appendAssistantFromApiResponse(
  event: ClaudeOtelEvent,
  interactions: any[],
  state: {
    finalResult: string;
    model: string;
    responseMetaByKey: Map<string, { request?: ClaudeOtelEvent; body: any; content: any[] }>;
    responseToToolId: Map<string, string>;
    toolUseById: Map<string, any>;
    subagentSessionByToolId: Map<string, string>;
  },
): void {
  const attrs = event.attributes || {};
  const meta = state.responseMetaByKey.get(eventKey(event));
  const body = meta?.body || readBodyPayload(attrs);
  if (!body) return;
  const content = meta?.content || contentBlocksFromResponseBody(body);
  const text = textFromContent(content);
  if (text.trim()) state.finalResult = text;
  if (attrs.model || body.model) state.model = String(attrs.model || body.model);

  const requestEvent = meta?.request;
  const usage = normalizeUsage(body.usage, requestEvent?.attributes || {});
  const taskToolCalls = toolUseBlocks(content).map(buildToolCallFromToolUse);
  const linkedToolId = state.responseToToolId.get(eventKey(event));
  const linkedToolUse = linkedToolId ? state.toolUseById.get(linkedToolId) : undefined;
  const isSubagentResponse = !!linkedToolId && linkedToolUse?.name === 'Agent';
  const subagentName = isSubagentResponse ? subagentNameFromToolUse(linkedToolUse) : undefined;
  const subagentSessionId = linkedToolId ? state.subagentSessionByToolId.get(linkedToolId) : undefined;

  interactions.push({
    role: isSubagentResponse ? 'subagent' : 'assistant',
    content: text,
    content_blocks: content,
    timestamp: eventTime(event),
    timeInfo: interactionTimeInfo(requestEvent, event),
    agent: isSubagentResponse ? subagentName : ROOT_AGENT_NAME,
    subagent_name: isSubagentResponse ? subagentName : undefined,
    subagent_session_id: isSubagentResponse ? subagentSessionId || `${event.sessionId}:${linkedToolId}` : undefined,
    prompt_id: event.promptId,
    model: attrs.model || body.model,
    request_id: attrs.request_id || body.id,
    stop_reason: body.stop_reason,
    usage,
    tool_calls: taskToolCalls.length > 0 ? taskToolCalls : undefined,
  });
}

export function aggregateClaudeOtelEvents(sessionId: string, events: ClaudeOtelEvent[]): ExecutionRecord | null {
  const ordered = dedupeEvents(events)
    .filter((event) => event.sessionId === sessionId)
    .sort((a, b) => eventSortValue(a) - eventSortValue(b));

  if (ordered.length === 0) return null;

  const interactions: any[] = [];
  const responseMetaByKey = new Map<string, { request?: ClaudeOtelEvent; body: any; content: any[] }>();
  const toolUseById = new Map<string, any>();
  const subagentSessionByToolId = new Map<string, string>();
  const responseToToolId = new Map<string, string>();
  const subagentOutputByToolId = new Map<string, string>();
  let query = '';
  let finalResult = '';
  let model = '';
  let cost = 0;
  let latencyMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let maxSingleCallTokens = 0;
  let llmCallCount = 0;
  let toolCallCount = 0;
  let toolCallErrorCount = 0;
  let timestamp = eventTime(ordered[0]);
  let user = ordered.find((e) => e.user)?.user;
  const skills = new Set<string>();
  const agentNames = new Set<string>([ROOT_AGENT_NAME]);

  const pendingRequestsByPrompt = new Map<string, ClaudeOtelEvent[]>();
  for (const event of ordered) {
    if (event.eventName === 'api_request') {
      const key = promptKey(event);
      const queue = pendingRequestsByPrompt.get(key) || [];
      queue.push(event);
      pendingRequestsByPrompt.set(key, queue);
      continue;
    }
    if (event.eventName !== 'api_response_body') continue;
    const body = readBodyPayload(event.attributes || {});
    if (!body) continue;
    const key = promptKey(event);
    const request = pendingRequestsByPrompt.get(key)?.shift();
    const content = contentBlocksFromResponseBody(body);
    responseMetaByKey.set(eventKey(event), { request, body, content });
    for (const block of toolUseBlocks(content)) {
      toolUseById.set(block.id, block);
      if (block.name === 'Agent') {
        const subagentName = subagentNameFromToolUse(block);
        subagentSessionByToolId.set(block.id, `${event.sessionId}:${event.promptId || 'prompt'}:${subagentName}:${block.id}`);
      }
    }
  }

  const assignedSubagentResponses = new Set<string>();
  for (let i = 0; i < ordered.length; i++) {
    const event = ordered[i];
    if (event.eventName !== 'tool_result') continue;
    const toolId = event.attributes?.tool_use_id;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = ordered[j];
      if (candidate.promptId !== event.promptId || candidate.sessionId !== event.sessionId) continue;
      if (candidate.eventName === 'user_prompt') break;
      if (candidate.eventName !== 'api_response_body') continue;
      const meta = responseMetaByKey.get(eventKey(candidate));
      if (!meta || hasToolUse(meta.content)) continue;
      const key = eventKey(candidate);
      if (assignedSubagentResponses.has(key)) continue;
      assignedSubagentResponses.add(key);
      if (typeof toolId === 'string' && toolId) {
        responseToToolId.set(key, toolId);
        subagentOutputByToolId.set(toolId, textFromContent(meta.content));
      }
      break;
    }
  }

  for (const event of ordered) {
    const attrs = event.attributes || {};
    if (!timestamp || Date.parse(eventTime(event)) < Date.parse(timestamp)) timestamp = eventTime(event);
    if (!user && event.user) user = event.user;

    if (event.eventName === 'user_prompt') {
      const prompt = asString(attrs.prompt) || '[Redacted Claude Code prompt]';
      if (!query && prompt !== '[Redacted Claude Code prompt]') query = prompt;
      interactions.push({
        role: 'user',
        content: prompt,
        timestamp: eventTime(event),
        timeInfo: { created: eventTime(event), completed: eventTime(event) },
        agent: ROOT_AGENT_NAME,
        prompt_id: event.promptId,
        command_name: attrs.command_name,
        command_source: attrs.command_source,
      });
      continue;
    }

    if (event.eventName === 'api_request') {
      const input = asNumber(attrs.input_tokens);
      const output = asNumber(attrs.output_tokens);
      const cacheRead = asNumber(attrs.cache_read_tokens);
      const cacheCreation = asNumber(attrs.cache_creation_tokens);
      const callTokens = input + output + cacheRead + cacheCreation;
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead;
      cacheCreationTokens += cacheCreation;
      maxSingleCallTokens = Math.max(maxSingleCallTokens, callTokens);
      cost += asNumber(attrs.cost_usd);
      latencyMs += asNumber(attrs.duration_ms);
      llmCallCount += 1;
      if (attrs.model) model = String(attrs.model);
      continue;
    }

    if (event.eventName === 'api_response_body') {
      const state = { finalResult, model, responseMetaByKey, responseToToolId, toolUseById, subagentSessionByToolId };
      appendAssistantFromApiResponse(event, interactions, state);
      finalResult = state.finalResult;
      model = state.model || model;
      const last = interactions[interactions.length - 1];
      if (last?.agent) agentNames.add(last.agent);
      continue;
    }

    if (event.eventName === 'tool_result') {
      toolCallCount += 1;
      if (String(attrs.success) === 'false') toolCallErrorCount += 1;
      const toolId = attrs.tool_use_id;
      const toolUse = typeof toolId === 'string' ? toolUseById.get(toolId) : undefined;
      const toolCall = buildToolCallFromResult(event, toolUse, typeof toolId === 'string' ? subagentOutputByToolId.get(toolId) : undefined);
      let target = interactions.find((m) => Array.isArray(m.tool_calls) && m.tool_calls.some((tc: any) => tc.id === toolCall.id));
      if (!target) target = [...interactions].reverse().find((m) => m.role === 'assistant');
      if (target) {
        const existing = Array.isArray(target.tool_calls) ? target.tool_calls : [];
        const idx = existing.findIndex((tc: any) => tc.id === toolCall.id);
        target.tool_calls = idx >= 0
          ? existing.map((tc: any, i: number) => i === idx ? mergeToolCall(tc, toolCall) : tc)
          : [...existing, toolCall];
      }
      const skillName = parseJsonMaybe(attrs.tool_parameters)?.skill_name || parseJsonMaybe(attrs.tool_input)?.skill;
      if (typeof skillName === 'string' && skillName.trim()) skills.add(skillName.trim());
      continue;
    }
  }

  if (!query) query = `Claude Code Session ${sessionId}`;

  if (!finalResult) {
    const lastAssistant = [...interactions].reverse().find((m) => m.role === 'assistant' && textFromContent(m.content).trim());
    finalResult = lastAssistant ? textFromContent(lastAssistant.content) : '';
  }

  return {
    task_id: sessionId,
    query,
    framework: 'claudecode',
    model,
    tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    cost,
    latency: latencyMs / 1000,
    timestamp,
    final_result: finalResult || '[No final text output]',
    interactions: normalizeClaudeCodeInteractionsForStorage(interactions),
    skills: Array.from(skills),
    agent: ROOT_AGENT_NAME,
    agentName: ROOT_AGENT_NAME,
    agents: Array.from(agentNames),
    user,
    tool_call_count: toolCallCount,
    llm_call_count: llmCallCount,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    tool_call_error_count: toolCallErrorCount,
    cache_read_input_tokens: cacheReadTokens,
    cache_creation_input_tokens: cacheCreationTokens,
    max_single_call_tokens: maxSingleCallTokens,
  };
}

export function aggregateClaudeOtelSession(sessionId: string): ClaudeOtelAggregationResult {
  const events = readClaudeOtelEventsForSession(sessionId);
  return {
    sessionId,
    eventCount: events.length,
    record: aggregateClaudeOtelEvents(sessionId, events),
  };
}
