import fs from 'node:fs';
import type { ExecutionRecord } from '@/lib/storage/data-service';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { resolveAgentInsightHomePath } from '@/lib/env';
import { CONTEXT_SUPPLEMENT_EVENT } from './context-supplement';
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

// 客户端补传事件(POST /api/ingest/claude/context)。Claude Code 官方 OTel logs 里
// 请求体只有 `body_ref`(客户端本机绝对路径),system prompt 只存在于请求体里、hook 注入的
// additionalContext 根本不进 OTel —— 服务端与客户端不同机时两者都拿不到。补传把这两样
// 从客户端磁盘捞出来,以本事件写进同一份 spool。

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

function stringifyToolResultContent(value: any): any {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        if (typeof item?.content === 'string') return item.content;
        return '';
      })
      .filter(Boolean)
      .join('');
    return text || value;
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content === 'string') return value.content;
    if (value.output !== undefined) return stringifyToolResultContent(value.output);
    if (value.result !== undefined) return stringifyToolResultContent(value.result);
  }
  return value;
}

function extractToolResultOutput(source: any): any {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of ['content', 'output', 'result', 'stdout', 'stderr']) {
    if (source[key] !== undefined) return stringifyToolResultContent(source[key]);
  }
  return undefined;
}

function toolResultUseId(block: any): string | undefined {
  return block?.tool_use_id || block?.toolUseId || block?.toolUseID || block?.id;
}

function resolveBodyRefPath(bodyRef: string): string {
  if (fs.existsSync(bodyRef)) return bodyRef;
  const idx = bodyRef.indexOf('claude_raw_bodies/');
  if (idx === -1) return bodyRef;
  return resolveAgentInsightHomePath(bodyRef.slice(idx));
}

function readBodyPayload(attrs: Record<string, any>): any {
  const inline = parseJsonMaybe(attrs.body);
  if (inline) return inline;

  const rawBodyRef = typeof attrs.body_ref === 'string' ? attrs.body_ref : '';
  if (!rawBodyRef) return null;
  const bodyRef = resolveBodyRefPath(rawBodyRef);
  try {
    if (!fs.existsSync(bodyRef)) return null;
    const text = fs.readFileSync(bodyRef, 'utf8');
    return parseJsonMaybe(text);
  } catch {
    return null;
  }
}

function collectToolResultOutputsFromRequestBody(body: any, outputsByToolId: Map<string, any>): void {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      const toolUseId = toolResultUseId(block);
      if (!toolUseId) continue;
      const output = extractToolResultOutput(block);
      if (output !== undefined) outputsByToolId.set(toolUseId, output);
    }
  }
}

/**
 * The Anthropic Messages request carries the system prompt in the top-level
 * `system` field (NOT in `messages`), as either a plain string or an array of
 * `{ type: 'text', text }` blocks (with optional cache_control). Flatten both
 * shapes to text; return '' when there is no usable system prompt.
 */
function stringifyAnthropicSystem(system: any): string {
  if (!system) return '';
  if (typeof system === 'string') return system.trim();
  if (Array.isArray(system)) {
    return system
      .map((block) => (typeof block === 'string' ? block : typeof block?.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof system === 'object' && typeof system.text === 'string') return system.text.trim();
  return '';
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

/**
 * Anthropic extended-thinking responses carry the model's reasoning as
 * `{ type: 'thinking', thinking }` blocks in the response content, separate from
 * the visible `{ type: 'text' }` blocks. The trace UI reads reasoning from
 * `parts[type='reasoning']` (the OpenCode shape), so surface those blocks there.
 * `redacted_thinking` blocks are encrypted with no readable text and are skipped.
 * Returns undefined when the turn carries no thinking.
 */
function reasoningPartsFromContent(content: any): Array<{ type: 'reasoning'; text: string }> | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: Array<{ type: 'reasoning'; text: string }> = [];
  for (const block of content) {
    if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
      parts.push({ type: 'reasoning', text: block.thinking });
    }
  }
  return parts.length > 0 ? parts : undefined;
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

function normalizeToolResultOutput(value: any): any {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s) return undefined;
  if (s === 'claude_code.tool_result' || s === 'tool_result') return undefined;
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {}
  }
  return value;
}

function readToolResultOutput(event: ClaudeOtelEvent, fallback?: any): any {
  const attrs = event.attributes || {};
  const outputKeys = [
    'tool_result',
    'tool_result_content',
    'tool_result_text',
    'tool_output',
    'tool_output_text',
    'output',
    'result',
  ];

  for (const key of outputKeys) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
    const value = normalizeToolResultOutput(attrs[key]);
    if (value !== undefined) return value;
  }

  const body = normalizeToolResultOutput(event.body);
  return body !== undefined ? body : fallback;
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

function mergeToolCallIntoInteraction(target: any, toolCall: any): void {
  const existing = Array.isArray(target.tool_calls) ? target.tool_calls : [];
  const idx = existing.findIndex((tc: any) => tc.id === toolCall.id);
  target.tool_calls = idx >= 0
    ? existing.map((tc: any, i: number) => i === idx ? mergeToolCall(tc, toolCall) : tc)
    : [...existing, toolCall];
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

/**
 * 跨机场景没有 tool_use 块,只能从 tool_result 事件重建出来的那条工具调用里取子 agent 类型
 * (`tool_input` 里带 subagent_type)。取不到就退回 normalizeSubagentType 的默认值。
 */
function subagentNameFromToolCall(toolCall: any): string {
  const args = parseJsonMaybe(toolCall?.arguments) || {};
  return normalizeSubagentType(args.subagent_type || args.subagentType);
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

type SystemPromptState = {
  systemByPromptKey: Map<string, string>;
  /** 客户端补传的 system prompt(会话级,raw body 里没有 promptId 可归)。 */
  supplementSystemTexts: string[];
  emittedSystemScopes: Set<string>;
};

/**
 * 该 prompt 要吐出的 system prompt 正文。**真实请求体永远优先**:只有本机读不到
 * `body_ref`(跨机部署)时才回落到客户端补传,所以同机部署的行为一字不变。
 */
function resolveSystemTexts(state: SystemPromptState, key: string): string[] {
  const real = state.systemByPromptKey.get(key);
  if (real) return [real];
  return state.supplementSystemTexts;
}

/** 同一份 system prompt 每个 scope(root / 各 Agent 子会话)只吐一条。 */
function pushSystemInteraction(
  interactions: any[],
  state: SystemPromptState,
  systemText: string,
  args: {
    event: ClaudeOtelEvent;
    requestEvent?: ClaudeOtelEvent;
    subSession?: string;
    agent: string;
    model?: any;
    supplemented: boolean;
  },
): void {
  const scopeKey = `${args.subSession || '__root__'}::${systemText}`;
  if (state.emittedSystemScopes.has(scopeKey)) return;
  state.emittedSystemScopes.add(scopeKey);
  interactions.push({
    role: 'system',
    content: systemText,
    system_prompt_length: systemText.length,
    ...(args.supplemented ? { system_prompt_source: 'client-supplement' } : {}),
    timestamp: eventTime(args.event),
    timeInfo: interactionTimeInfo(args.requestEvent, args.event),
    agent: args.agent,
    subagent_session_id: args.subSession,
    prompt_id: args.event.promptId,
    model: args.model,
  });
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
    systemByPromptKey: Map<string, string>;
    supplementSystemTexts: string[];
    emittedSystemScopes: Set<string>;
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

  // System prompt (top-level `system` of the matching api_request_body). The same
  // prompt repeats on every call of an agent, so emit it once per scope — root, or
  // each Agent sub-session — and let the trace builder stash it on that node.
  const key = promptKey(event);
  const supplemented = !state.systemByPromptKey.has(key);
  const resolvedSubSession = isSubagentResponse ? subagentSessionId || `${event.sessionId}:${linkedToolId}` : undefined;
  for (const systemText of resolveSystemTexts(state, key)) {
    pushSystemInteraction(interactions, state, systemText, {
      event,
      requestEvent,
      subSession: resolvedSubSession,
      agent: (isSubagentResponse ? subagentName : undefined) || ROOT_AGENT_NAME,
      model: attrs.model || body.model,
      supplemented,
    });
  }

  const reasoningParts = reasoningPartsFromContent(content);

  interactions.push({
    role: isSubagentResponse ? 'subagent' : 'assistant',
    content: text,
    content_blocks: content,
    ...(reasoningParts ? { parts: reasoningParts } : {}),
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
  // 补传是给已有 trace 补料的,自己不构成一条 trace。补传先于 OTel 日志到达(或那次会话
  // 的日志压根没上来)时直接不出记录,免得凭空多出一条只有 system prompt 的空 trace。
  if (ordered.every((event) => event.eventName === CONTEXT_SUPPLEMENT_EVENT)) return null;

  const interactions: any[] = [];
  const responseMetaByKey = new Map<string, { request?: ClaudeOtelEvent; body: any; content: any[] }>();
  const toolUseById = new Map<string, any>();
  const subagentSessionByToolId = new Map<string, string>();
  const responseToToolId = new Map<string, string>();
  const subagentOutputByToolId = new Map<string, string>();
  const pendingToolResultById = new Map<string, any>();
  const requestBodyToolOutputById = new Map<string, any>();
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

  const systemByPromptKey = new Map<string, string>();
  const emittedSystemScopes = new Set<string>();
  // 客户端补传:system prompt 走会话级(raw body 里没有 promptId),hook 注入上下文按内容去重。
  const supplementSystemTexts: string[] = [];
  const emittedHookContexts = new Set<string>();
  // 工具输出补传:tool_use_id → 输出正文。跨机时请求体读不到,这是唯一来源。
  const supplementToolOutputById = new Map<string, any>();
  const emittedSupplementSubagents = new Set<string>();
  const pendingSupplementSubagents: any[] = [];

  const pendingRequestsByPrompt = new Map<string, ClaudeOtelEvent[]>();
  // assistant_response 兜底路径(见下方主循环)要用同一批 api_request 取 usage/时间。
  // 单独一份队列各自消耗,免得两条路径互相打乱配对顺序。
  const fallbackRequestsByPrompt = new Map<string, ClaudeOtelEvent[]>();
  // 每个 prompt 下"正文真的读到了"的 api_response_body 条数,决定兜底要不要出手。
  const usableResponseCountByPrompt = new Map<string, number>();
  const assistantResponseSeenByPrompt = new Map<string, number>();
  for (const event of ordered) {
    if (event.eventName === 'api_request_body') {
      const body = readBodyPayload(event.attributes || {});
      if (body) {
        collectToolResultOutputsFromRequestBody(body, requestBodyToolOutputById);
        const systemText = stringifyAnthropicSystem(body.system);
        if (systemText) systemByPromptKey.set(promptKey(event), systemText);
      }
      continue;
    }
    if (event.eventName === CONTEXT_SUPPLEMENT_EVENT) {
      // hook 注入上下文在主循环里落成 interaction;这里只收发射前就得备好的两类。
      const attrs = event.attributes || {};
      if (attrs.kind === 'system_prompt') {
        const text = asString(attrs.text).trim();
        if (text && !supplementSystemTexts.includes(text)) supplementSystemTexts.push(text);
      } else if (attrs.kind === 'tool_output') {
        const toolUseId = asString(attrs.tool_use_id);
        const output = normalizeToolResultOutput(attrs.text);
        if (toolUseId && output !== undefined) supplementToolOutputById.set(toolUseId, output);
      }
      continue;
    }
    if (event.eventName === 'api_request') {
      const key = promptKey(event);
      const queue = pendingRequestsByPrompt.get(key) || [];
      queue.push(event);
      pendingRequestsByPrompt.set(key, queue);
      const fallbackQueue = fallbackRequestsByPrompt.get(key) || [];
      fallbackQueue.push(event);
      fallbackRequestsByPrompt.set(key, fallbackQueue);
      continue;
    }
    if (event.eventName !== 'api_response_body') continue;
    const body = readBodyPayload(event.attributes || {});
    if (!body) continue;
    const key = promptKey(event);
    usableResponseCountByPrompt.set(key, (usableResponseCountByPrompt.get(key) || 0) + 1);
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

    // hook 注入的 additionalContext:是"喂给模型的上下文",不是用户输入,所以单独一类
    // role,既不进 query/首条 user 的口径,也不被按 user/assistant 取值的下游(评测、
    // fault-path、call-stats)看见 —— 它们都是按具体 role 白名单取的。
    if (event.eventName === CONTEXT_SUPPLEMENT_EVENT) {
      if (attrs.kind !== 'hook_context') continue;
      const text = asString(attrs.text).trim();
      if (!text) continue;
      const hookEvent = asString(attrs.hook_event);
      const dedupeKey = `${hookEvent}::${asString(attrs.content_hash) || text}`;
      if (emittedHookContexts.has(dedupeKey)) continue;
      emittedHookContexts.add(dedupeKey);
      interactions.push({
        role: 'hook_context',
        content: text,
        hook_event: hookEvent || undefined,
        hook_name: asString(attrs.hook_name) || undefined,
        hook_context_length: text.length,
        timestamp: eventTime(event),
        timeInfo: { created: eventTime(event), completed: eventTime(event) },
        agent: ROOT_AGENT_NAME,
        prompt_id: event.promptId,
      });
      continue;
    }

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
      const state = { finalResult, model, responseMetaByKey, responseToToolId, toolUseById, subagentSessionByToolId, systemByPromptKey, supplementSystemTexts, emittedSystemScopes };
      appendAssistantFromApiResponse(event, interactions, state);
      finalResult = state.finalResult;
      model = state.model || model;
      const last = interactions[interactions.length - 1];
      if (last && Array.isArray(last.tool_calls)) {
        for (const toolCall of last.tool_calls) {
          if (!toolCall?.id || !pendingToolResultById.has(toolCall.id)) continue;
          mergeToolCallIntoInteraction(last, pendingToolResultById.get(toolCall.id));
          pendingToolResultById.delete(toolCall.id);
        }
      }
      if (last?.agent) agentNames.add(last.agent);
      continue;
    }

    // assistant_response 自带完整回复正文(attributes.response),和 api_response_body
    // 是同一次 LLM 调用的两份记录。api_response_body 的正文走 body_ref 指向【客户端
    // 本机磁盘】,服务端与客户端不同机时(远端部署 / 容器 / 不同用户)永远读不到 ——
    // 那条路径会 return 掉整条助手消息,trace 只剩 user、`trace_completed_at` 永远推不出来,
    // 前端就一直显示"执行中"。所以这里在"本 prompt 没有可用 api_response_body"时兜底,
    // 保证回复正文与可收敛的完成状态不依赖跨机文件。
    // 局限(受事件本身所限,非本兜底可解):不含 tool_use 块,故拿不到 subagent 层级。
    // 系统提示词同样不在事件里,但客户端补传(context_supplement)能补上,见下方发射。
    if (event.eventName === 'assistant_response') {
      const key = promptKey(event);
      const seen = assistantResponseSeenByPrompt.get(key) || 0;
      assistantResponseSeenByPrompt.set(key, seen + 1);
      // 队列按 assistant_response 的出现顺序对齐消耗,跳过时也要 shift,否则混合场景错配
      const requestEvent = fallbackRequestsByPrompt.get(key)?.shift();
      // 生成会话标题是 Claude Code 的内部 LLM 调用,不是对话内容
      if (attrs.query_source === 'generate_session_title') continue;
      if (seen < (usableResponseCountByPrompt.get(key) || 0)) continue;
      const text = asString(attrs.response);
      if (!text.trim()) continue;
      finalResult = text;
      if (attrs.model) model = String(attrs.model);
      // 跨机场景只有这条兜底路径会跑,system prompt 得在这里发射(root scope —— 本事件
      // 不带 tool_use,分不出子 agent)。同机部署走上面的 api_response_body 路径,不受影响。
      const systemState = { systemByPromptKey, supplementSystemTexts, emittedSystemScopes };
      for (const systemText of resolveSystemTexts(systemState, key)) {
        pushSystemInteraction(interactions, systemState, systemText, {
          event,
          requestEvent,
          agent: ROOT_AGENT_NAME,
          model: attrs.model,
          supplemented: !systemByPromptKey.has(key),
        });
      }
      interactions.push({
        role: 'assistant',
        content: text,
        timestamp: eventTime(event),
        timeInfo: interactionTimeInfo(requestEvent, event),
        agent: ROOT_AGENT_NAME,
        prompt_id: event.promptId,
        model: attrs.model,
        usage: normalizeUsage(undefined, requestEvent?.attributes || {}),
      });
      // 跨机时 tool_result 可能先于本轮助手消息到达 —— 那会儿还没有任何 assistant 可挂,
      // 工具调用只能滞留在 pendingToolResultById。正常路径靠 api_response_body 分支收口,
      // 而跨机根本不会走那条,不在这里收就整批工具调用凭空消失(trace 只剩对话)。
      const assistantTurn = interactions[interactions.length - 1];
      for (const [pendingId, pendingCall] of pendingToolResultById) {
        mergeToolCallIntoInteraction(assistantTurn, pendingCall);
        pendingToolResultById.delete(pendingId);
      }
      continue;
    }

    if (event.eventName === 'tool_result') {
      toolCallCount += 1;
      if (String(attrs.success) === 'false') toolCallErrorCount += 1;
      const toolId = attrs.tool_use_id;
      const toolUse = typeof toolId === 'string' ? toolUseById.get(toolId) : undefined;
      // 输出的取值优先级:真实请求体 → 客户端补传 → 子 agent 回复兜底。
      // 补传排在请求体之后:同机部署读得到真身时,行为一字不变。
      const fallbackOutput = typeof toolId === 'string'
        ? (requestBodyToolOutputById.has(toolId) ? requestBodyToolOutputById.get(toolId)
          : supplementToolOutputById.has(toolId) ? supplementToolOutputById.get(toolId)
            : subagentOutputByToolId.get(toolId))
        : undefined;
      const toolCall = buildToolCallFromResult(event, toolUse, readToolResultOutput(event, fallbackOutput));
      let target = interactions.find((m) => Array.isArray(m.tool_calls) && m.tool_calls.some((tc: any) => tc.id === toolCall.id));
      // 读不到 api_response_body 的正文就拿不到 tool_use 块,tool_use_id 永远匹配不上,
      // 工具调用会全部滞留在 pendingToolResultById 里被丢掉(trace 只有对话没有工具)。
      // 这种情况按时间就近挂到当前最后一条助手消息 —— 主循环按事件时间推进,那条正是
      // 发起本次调用的一轮。正文可读的正常路径不能这么挂:那边 tool_result 先到、
      // assistant 后产出,提前挂会挂到上一轮,所以仍走 pending 等合并。
      const responseBodyUsable = (usableResponseCountByPrompt.get(promptKey(event)) || 0) > 0;
      if (!target && (!toolCall.id || !responseBodyUsable)) {
        target = [...interactions].reverse().find((m) => m.role === 'assistant');
      }
      if (target) {
        mergeToolCallIntoInteraction(target, toolCall);
      } else if (toolCall.id) {
        const existing = pendingToolResultById.get(toolCall.id);
        pendingToolResultById.set(toolCall.id, existing ? mergeToolCall(existing, toolCall) : toolCall);
      }
      // 子 agent 那一轮本来只能从响应体正文里拿(responseToToolId → role='subagent'),
      // 跨机读不到就整棵子树消失、Task 调用永远没人认领。补传拿到这次 Task 的输出后,
      // 这里补一条 role='subagent',让 buildAgentCallTree 认领上面那条 task 调用长出子节点。
      // 同机(subagentOutputByToolId 已有值)不进这里,避免双份。
      // `!toolUse` 是"跨机"的判据:读得到响应体正文时一定有 tool_use 块,那条路径自己会
      // 产出子 agent 轮次,这里绝不能插手(否则同机会出现两份)。
      if (
        toolCall.name === 'task' &&
        typeof toolId === 'string' &&
        !toolUse &&
        !subagentOutputByToolId.has(toolId) &&
        !emittedSupplementSubagents.has(toolId)
      ) {
        const text = textFromContent(supplementToolOutputById.get(toolId) ?? toolCall.output);
        if (text.trim()) {
          emittedSupplementSubagents.add(toolId);
          const subagentName = subagentNameFromToolCall(toolCall);
          agentNames.add(subagentName);
          const timing = toolTimingFromResult(event);
          // 攒着,主循环结束后再追加:建树时子 agent 那一轮要认领父轮上的 task 调用,
          // 而跨机的 task 调用可能到本轮助手消息落地时才挂上去(见上面的 pending 收口)。
          // 先于父轮出现就认领不到,子节点会塌回 root。
          pendingSupplementSubagents.push({
            role: 'subagent',
            content: text,
            timestamp: eventTime(event),
            // timeInfo 用 created/completed 命名(下游 getInteractionActivityMs 按这套读),
            // 起点取工具调用的实际开始时间,子节点时长才是子 agent 真正跑的那段。
            timeInfo: { created: timing.started_at || eventTime(event), completed: timing.completed_at },
            agent: subagentName,
            subagent_name: subagentName,
            subagent_session_id: `${event.sessionId}:${toolId}`,
            prompt_id: event.promptId,
            subagent_source: 'client-supplement',
          });
        }
      }

      const skillName = parseJsonMaybe(attrs.tool_parameters)?.skill_name || parseJsonMaybe(attrs.tool_input)?.skill;
      if (typeof skillName === 'string' && skillName.trim()) skills.add(skillName.trim());
      continue;
    }
  }

  // 补传出来的子 agent 轮次统一放在最后:此时父轮上的 task 调用一定已经就位,建树能认领到。
  interactions.push(...pendingSupplementSubagents);

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
