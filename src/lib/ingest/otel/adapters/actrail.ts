import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { InvokedSkill } from '@/lib/shared/interaction-utils';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

type AnyObject = Record<string, any>;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function actionKind(event: OtelTraceEvent): string {
  return text(event.attributes?.['actrail.action.kind']) || '';
}

function actionId(event: OtelTraceEvent): string | undefined {
  return text(event.attributes?.['actrail.action.id']);
}

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function parseToolCalls(response: OtelTraceEvent | undefined, call: OtelTraceEvent): AnyObject[] {
  const parsed = parseJson(response?.attributes?.['llm.response.tool_calls_json']);
  if (!Array.isArray(parsed)) return [];

  const startedAt = call.startTimeMs || Date.parse(call.receivedAt) || Date.now();
  const completedAt = eventEndMs(call) || startedAt;
  return parsed
    .filter((item) => item && typeof item === 'object')
    .map((item: any, index) => {
      const name = text(item?.function?.name) || text(item?.name) || 'tool';
      const rawArguments = item?.function?.arguments ?? item?.arguments ?? {};
      return {
        id: text(item?.id) || `${call.spanId || 'actrail-call'}:tool:${index}`,
        type: text(item?.type) || 'function',
        function: {
          name,
          arguments: typeof rawArguments === 'string'
            ? rawArguments
            : JSON.stringify(rawArguments),
        },
        timing: {
          started_at: toIso(startedAt),
          completed_at: toIso(completedAt),
        },
      };
    });
}

function skillCalls(toolCalls: AnyObject[]): InvokedSkill[] {
  const seen = new Set<string>();
  const skills: InvokedSkill[] = [];
  for (const call of toolCalls) {
    const name = text(call?.function?.name)?.toLowerCase();
    if (name !== 'skill' && name !== 'load_skill') continue;
    const args = parseJson(call?.function?.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    const skillName = text((args as AnyObject).name || (args as AnyObject).skill_name || (args as AnyObject).skill);
    if (!skillName || seen.has(skillName)) continue;
    seen.add(skillName);
    const rawVersion = (args as AnyObject).version;
    const numericVersion = rawVersion === undefined || rawVersion === null
      ? null
      : Number(rawVersion);
    skills.push({
      name: skillName,
      version: numericVersion !== null && Number.isFinite(numericVersion)
        ? numericVersion
        : null,
    });
  }
  return skills;
}

function headerValue(headers: unknown, name: string): string | undefined {
  const source = text(headers);
  if (!source) return undefined;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text(source.match(new RegExp(`(?:^|\\r?\\n)${escaped}\\s*:\\s*([^\\r\\n]+)`, 'i'))?.[1]);
}

function agentNameFromRequestUserAgent(events: OtelTraceEvent[]): string | undefined {
  for (const event of events) {
    if (actionKind(event) !== 'llm.request') continue;
    const userAgent = text(event.attributes?.['http.request.header.user-agent']) ||
      text(event.attributes?.['http.request.header.user_agent']) ||
      text(event.attributes?.['user_agent.original']) ||
      headerValue(event.attributes?.['http.request.headers_text'], 'user-agent');
    if (!userAgent) continue;

    if (userAgent.toLowerCase().includes('claude-cli/')) return 'Claude Code';
  }
  return undefined;
}

function selectAgentName(events: OtelTraceEvent[]): string {
  const identity = events.find((event) => actionKind(event) === 'agent.identity');
  const explicitIdentity = text(identity?.attributes?.['agent.name']) ||
    text(identity?.attributes?.['agent.child.executable']);
  if (explicitIdentity) return explicitIdentity;

  const requestAgentName = agentNameFromRequestUserAgent(events);
  if (requestAgentName) return requestAgentName;

  const invocation = events.find((event) =>
    actionKind(event) === 'command.invocation' &&
    text(event.attributes?.['invocation.kind']) === 'agent'
  );
  const invocationName = text(invocation?.attributes?.['agent.child.executable']) ||
    text(invocation?.name);
  if (invocationName) return invocationName;

  const identityName = text(identity?.name);
  if (identityName && !/^agent identity process-[\w.-]+$/i.test(identityName)) return identityName;
  return 'AcTrail Agent';
}

function usageFrom(response: OtelTraceEvent | undefined) {
  const usage = response?.usage;
  return {
    input: usage?.input_tokens || 0,
    output: usage?.output_tokens || 0,
    reasoning: usage?.reasoning_tokens || 0,
    total: usage?.total_tokens || 0,
  };
}

function requestAgentSessionId(pair: LlmPair): string | undefined {
  return text(pair.request?.attributes?.['actrail.agent.session_id']);
}

function llmCallErrorMessage(pair: LlmPair): string {
  const statusCode = text(pair.call.attributes?.['http.response.status_code']) ||
    text(pair.response?.attributes?.['http.response.status_code']);
  const reason = text(pair.call.attributes?.['http.response.reason']) ||
    text(pair.response?.attributes?.['http.response.reason']);
  const httpError = [statusCode, reason].filter(Boolean).join(' ');
  return httpError ? `LLM 调用失败：HTTP ${httpError}` : 'LLM 调用失败';
}

function visibleContent(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return value
      .map((item) => visibleContent(item))
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (!value || typeof value !== 'object') return '';

  const object = value as AnyObject;
  const type = text(object.type)?.toLowerCase();
  if (type === 'tool_result' || type === 'tool_use' || type === 'function_call' || type === 'function_call_output') {
    return '';
  }
  return visibleContent(object.text ?? object.input_text ?? object.content ?? object.value);
}

function canonicalRequestPrompt(pair: LlmPair): string | undefined {
  const parsed = parseJson(pair.request?.attributes?.['llm.request.canonical_body_json']);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const object = parsed as AnyObject;
  const messages = Array.isArray(object.messages)
    ? object.messages
    : Array.isArray(object.input)
      ? object.input
      : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const role = text((message as AnyObject).role)?.toLowerCase();
    if (role !== 'user' && role !== 'human') continue;
    const content = visibleContent((message as AnyObject).content ?? (message as AnyObject).text);
    if (content) return content;
  }

  return visibleContent(object.prompt ?? object.input) || undefined;
}

function pairPrompt(pair: LlmPair): string | undefined {
  return canonicalRequestPrompt(pair) || text(pair.request?.attributes?.['llm.request.message_preview']);
}

const REQUEST_MESSAGE_MAX_CHARS = 4_000;
const REQUEST_MESSAGES_MAX_COUNT = 60;

function requestMessageRole(value: unknown): string {
  const role = String(value || 'user').trim().toLowerCase();
  if (role === 'human') return 'user';
  if (role === 'ai' || role === 'model') return 'assistant';
  return role || 'user';
}

function requestMessageContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => requestMessageContent(item))
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  if (typeof value !== 'object') return String(value);

  const item = value as AnyObject;
  const type = text(item.type)?.toLowerCase();
  if (type === 'tool_use' || type === 'function_call' || type === 'thinking') return '';
  return requestMessageContent(item.text ?? item.input_text ?? item.content ?? item.output ?? item.result ?? item.value);
}

function requestMessageToolCalls(value: unknown): AnyObject[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
    const item = block as AnyObject;
    const type = text(item.type)?.toLowerCase();
    if (type !== 'tool_use' && type !== 'function_call') return [];
    const name = text(item.name || item.function?.name);
    if (!name) return [];
    const rawArguments = item.input ?? item.arguments ?? item.function?.arguments ?? {};
    return [{
      id: text(item.id || item.call_id || item.tool_call_id),
      type: 'function',
      function: {
        name,
        arguments: typeof rawArguments === 'string' ? rawArguments : JSON.stringify(rawArguments),
      },
    }];
  });
}

function requestMessageToolResultId(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .flatMap((block) => {
      if (!block || typeof block !== 'object' || Array.isArray(block)) return [];
      const item = block as AnyObject;
      const type = text(item.type)?.toLowerCase();
      if (type !== 'tool_result' && type !== 'function_call_output') return [];
      const id = text(item.tool_use_id || item.tool_call_id || item.call_id);
      return id ? [id] : [];
    });
  return ids.length === 1 ? ids[0] : undefined;
}

function canonicalRequestMessages(pair: LlmPair): AnyObject[] {
  const parsed = parseJson(pair.request?.attributes?.['llm.request.canonical_body_json']);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const body = parsed as AnyObject;
  const rawMessages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : [];
  const sourceMessages = body.system === undefined
    ? rawMessages
    : [{ role: 'system', content: body.system }, ...rawMessages];
  let messages: AnyObject[] = [];

  for (const item of sourceMessages) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const message = item as AnyObject;
    const role = requestMessageRole(message.role ?? message.type);
    const rawContent = message.content ?? message.text;
    const content = requestMessageContent(rawContent);
    const contentToolCalls = requestMessageToolCalls(rawContent);
    const toolCalls = Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls
      : contentToolCalls.length > 0 ? contentToolCalls : undefined;
    const toolCallId = text(message.tool_call_id) || requestMessageToolResultId(rawContent);
    if (!content.trim() && !toolCalls?.length && !toolCallId) continue;

    const clipped = content.length > REQUEST_MESSAGE_MAX_CHARS
      ? `${content.slice(0, REQUEST_MESSAGE_MAX_CHARS)}\n…[已截断,原文 ${content.length} 字]`
      : content;
    const name = text(message.name);
    messages.push({
      role,
      content: clipped,
      ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      ...(toolCallId ? { tool_call_id: toolCallId } : {}),
      ...(name ? { name } : {}),
    });
  }

  if (messages.length > REQUEST_MESSAGES_MAX_COUNT) {
    const head = messages.slice(0, 2);
    const tail = messages.slice(-(REQUEST_MESSAGES_MAX_COUNT - head.length - 1));
    messages = [
      ...head,
      { role: 'system', content: `…[省略 ${messages.length - head.length - tail.length} 条历史消息]` },
      ...tail,
    ];
  }
  return messages;
}

function rootPromptSelection(pairs: LlmPair[]): {
  prompts: Set<string>;
  inference: 'dominant-request-session' | 'repeated-request-preview' | 'first-request-preview';
  rootSessionId?: string;
  observedSessionCount: number;
} {
  const sessionCounts = new Map<string, number>();
  for (const pair of pairs) {
    const agentSessionId = requestAgentSessionId(pair);
    if (agentSessionId) {
      sessionCounts.set(agentSessionId, (sessionCounts.get(agentSessionId) || 0) + 1);
    }
  }

  const rootSessionId = [...sessionCounts.entries()]
    .sort((left, right) => right[1] - left[1])[0]?.[0];
  if (rootSessionId) {
    const prompts = new Set(
      pairs
        .filter((pair) => requestAgentSessionId(pair) === rootSessionId)
        .map(pairPrompt)
        .filter((prompt): prompt is string => Boolean(prompt)),
    );
    if (prompts.size > 0) {
      return {
        prompts,
        inference: 'dominant-request-session',
        rootSessionId,
        observedSessionCount: sessionCounts.size,
      };
    }
  }

  const counts = new Map<string, number>();
  for (const pair of pairs) {
    const prompt = pairPrompt(pair);
    if (prompt) counts.set(prompt, (counts.get(prompt) || 0) + 1);
  }
  const repeated = new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([prompt]) => prompt),
  );
  if (repeated.size > 0) {
    return {
      prompts: repeated,
      inference: 'repeated-request-preview',
      observedSessionCount: sessionCounts.size,
    };
  }

  const first = pairs
    .map(pairPrompt)
    .find(Boolean);
  return {
    prompts: first ? new Set([first]) : new Set(),
    inference: 'first-request-preview',
    observedSessionCount: sessionCounts.size,
  };
}

type LlmPair = {
  call: OtelTraceEvent;
  request?: OtelTraceEvent;
  response?: OtelTraceEvent;
};

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || ['true', '1', 'yes'].includes(String(value || '').trim().toLowerCase());
}

function requestPreview(pair: LlmPair): string | undefined {
  return text(pair.request?.attributes?.['llm.request.message_preview']);
}

function sessionPrompt(prompt: string | undefined): string | undefined {
  if (!prompt) return undefined;
  const match = prompt.match(/<session>\s*([\s\S]*?)\s*<\/session>/i);
  return text(match?.[1]);
}

function isTitleGenerationPair(pair: LlmPair): boolean {
  if (text(pair.request?.attributes?.['llm.request.background_kind']) === 'title_generation') {
    return true;
  }

  const prompt = requestPreview(pair);
  if (!sessionPrompt(prompt) || !/<\/session>[\s\S]*\bWrite the title\b/i.test(prompt || '')) {
    return false;
  }

  const response = parseJson(pair.response?.attributes?.['llm.response.content_text']);
  return Boolean(
    response &&
    typeof response === 'object' &&
    !Array.isArray(response) &&
    text((response as AnyObject).title),
  );
}

function isInternalLlmPair(pair: LlmPair): boolean {
  return isTitleGenerationPair(pair) || [pair.request, pair.call, pair.response].some((event) =>
    isTruthy(event?.attributes?.['actrail.llm.internal'])
  );
}

function primaryTitlePrompt(pairs: LlmPair[]): string | undefined {
  const prompts = pairs
    .filter(isTitleGenerationPair)
    .map((pair) => requestPreview(pair))
    .filter((prompt): prompt is string => Boolean(prompt));
  const prompt = prompts.find((candidate) =>
    !candidate.startsWith('The following is the text to summarize:') &&
    !candidate.startsWith('You are a title generator')
  ) || prompts[0];
  return sessionPrompt(prompt) || prompt;
}

function pairStartMs(pair: LlmPair): number {
  const starts = [pair.request, pair.call, pair.response]
    .map((event) => event?.startTimeMs || 0)
    .filter((value) => value > 0);
  return starts.length > 0
    ? Math.min(...starts)
    : Date.parse(pair.call.receivedAt) || Date.now();
}

function pairEndMs(pair: LlmPair): number {
  const ends = [pair.request, pair.call, pair.response]
    .filter((event): event is OtelTraceEvent => Boolean(event))
    .map(eventEndMs)
    .filter((value) => value > 0);
  return ends.length > 0 ? Math.max(...ends) : pairStartMs(pair);
}

function buildLlmPairs(events: OtelTraceEvent[]): LlmPair[] {
  const byActionId = new Map<string, OtelTraceEvent>();
  for (const event of events) {
    const id = actionId(event);
    if (id) byActionId.set(id, event);
  }

  return events
    .filter((event) => actionKind(event) === 'llm.call')
    .map((call) => ({
      call,
      request: byActionId.get(text(call.attributes?.['llm.call.request_action_id']) || ''),
      response: byActionId.get(text(call.attributes?.['llm.call.response_action_id']) || ''),
    }))
    .sort((left, right) => left.call.startTimeMs - right.call.startTimeMs);
}

function linkedParentSpanId(event: OtelTraceEvent, role: string): string | undefined {
  return event.links?.find((link) => text(link.attributes?.['actrail.link.role']) === role)?.spanId;
}

type ToolProjection = {
  pair: LlmPair;
  call: AnyObject;
  event?: OtelTraceEvent;
};

type SubagentOwner = {
  sessionId: string;
  name: string;
  type: string;
};

type ActrailGraphProjection = {
  toolCallsByPair: Map<LlmPair, AnyObject[]>;
  pairOwners: Map<LlmPair, SubagentOwner>;
  matchedToolResults: number;
  toolResultBodies: number;
  toolCallErrors: number;
  linkedSubagentInvocations: number;
};

function parsedArguments(call: AnyObject): AnyObject {
  const parsed = parseJson(call?.function?.arguments ?? call?.arguments);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? { ...(parsed as AnyObject) }
    : parsed === undefined || parsed === null || parsed === ''
      ? {}
      : { description: String(parsed) };
}

function toolResultContent(event: OtelTraceEvent): unknown {
  const raw = event.attributes?.['llm.tool_result.content_json'];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return parseJson(raw);
}

type CanonicalToolResult = {
  callId: string;
  output: string;
  isError: boolean;
  observedAtMs: number;
};

function canonicalToolResults(pair: LlmPair): CanonicalToolResult[] {
  const parsed = parseJson(pair.request?.attributes?.['llm.request.canonical_body_json']);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const body = parsed as AnyObject;
  const messages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : [];
  const results: CanonicalToolResult[] = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    const content = (message as AnyObject).content;
    if (!Array.isArray(content)) continue;
    let current: { callId: string; parts: string[]; isError: boolean } | undefined;
    const flush = () => {
      if (!current) return;
      const output = current.parts.filter(Boolean).join('\n\n').trim();
      if (output) {
        results.push({
          callId: current.callId,
          output,
          isError: current.isError,
          observedAtMs: pair.request?.startTimeMs || pairStartMs(pair),
        });
      }
      current = undefined;
    };

    for (const block of content) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const item = block as AnyObject;
      const type = text(item.type)?.toLowerCase();
      if (type === 'tool_result' || type === 'function_call_output') {
        flush();
        const callId = text(item.tool_use_id || item.tool_call_id || item.call_id);
        if (!callId) continue;
        current = { callId, parts: [], isError: isTruthy(item.is_error) };
        const value = item.content ?? item.output ?? item.result;
        const part = requestMessageContent(value).trim();
        if (part) current.parts.push(part);
        continue;
      }
      if (!current) continue;
      const value = item.text ?? item.content ?? item.output ?? item.value;
      const part = requestMessageContent(value).trim();
      if (part) current.parts.push(part);
    }
    flush();
  }

  return results;
}

function buildActrailGraphProjection(
  events: OtelTraceEvent[],
  pairs: LlmPair[],
): ActrailGraphProjection {
  const pairByResponseSpanId = new Map<string, LlmPair>();
  const pairByResponseActionId = new Map<string, LlmPair>();
  const pairByRequestSpanId = new Map<string, LlmPair>();
  for (const pair of pairs) {
    if (pair.response?.spanId) pairByResponseSpanId.set(pair.response.spanId, pair);
    const responseId = actionId(pair.response || pair.call);
    if (responseId) pairByResponseActionId.set(responseId, pair);
    if (pair.request?.spanId) pairByRequestSpanId.set(pair.request.spanId, pair);
  }

  const embeddedByPair = new Map<LlmPair, AnyObject[]>();
  for (const pair of pairs) embeddedByPair.set(pair, parseToolCalls(pair.response, pair.call));

  const projectionsByPair = new Map<LlmPair, ToolProjection[]>();
  const projectionBySpanId = new Map<string, ToolProjection>();
  const projectionsByActionId = new Map<string, ToolProjection[]>();
  const projectionsByCallId = new Map<string, ToolProjection[]>();
  const toolEvents = events
    .filter((event) => actionKind(event) === 'llm.tool_call')
    .sort((left, right) => left.startTimeMs - right.startTimeMs);

  for (const event of toolEvents) {
    const responseSpanId = linkedParentSpanId(event, 'llm.response.tool_call') || event.parentSpanId;
    const responseActionId = text(event.attributes?.['llm.tool_call.response_action_id']);
    const pair = (responseSpanId ? pairByResponseSpanId.get(responseSpanId) : undefined) ||
      (responseActionId ? pairByResponseActionId.get(responseActionId) : undefined);
    if (!pair) continue;

    const embedded = embeddedByPair.get(pair) || [];
    const callId = text(event.attributes?.['llm.tool_call.id']);
    const ordinal = Number(event.attributes?.['llm.tool_call.ordinal']);
    const toolName = text(event.attributes?.['llm.tool_call.name']);
    const template = embedded.find((call) => callId && text(call.id) === callId) ||
      (Number.isInteger(ordinal) && ordinal >= 0 ? embedded[ordinal] : undefined) ||
      embedded.find((call) => toolName && text(call?.function?.name) === toolName);
    const startedAt = event.startTimeMs || pairStartMs(pair);
    const completedAt = eventEndMs(event) || startedAt;
    const call: AnyObject = {
      ...(template || {}),
      id: callId || text(template?.id) || event.spanId || actionId(event) || 'actrail-tool',
      type: text(template?.type) || 'function',
      function: {
        ...(template?.function || {}),
        name: toolName || text(template?.function?.name) || 'tool',
        arguments: typeof template?.function?.arguments === 'string'
          ? template.function.arguments
          : JSON.stringify(template?.function?.arguments || {}),
      },
      timing: {
        started_at: toIso(startedAt),
        completed_at: toIso(completedAt),
      },
    };
    const projection = { pair, call, event };
    const pairItems = projectionsByPair.get(pair) || [];
    pairItems.push(projection);
    projectionsByPair.set(pair, pairItems);
    if (event.spanId) projectionBySpanId.set(event.spanId, projection);
    const eventActionId = actionId(event);
    if (eventActionId) {
      const items = projectionsByActionId.get(eventActionId) || [];
      items.push(projection);
      projectionsByActionId.set(eventActionId, items);
    }
    if (callId) {
      const items = projectionsByCallId.get(callId) || [];
      items.push(projection);
      projectionsByCallId.set(callId, items);
    }
  }

  for (const pair of pairs) {
    const projections = projectionsByPair.get(pair) || [];
    for (const call of embeddedByPair.get(pair) || []) {
      const callId = text(call.id);
      const duplicate = projections.some((projection) =>
        (callId && text(projection.call.id) === callId) ||
        (!callId &&
          text(projection.call?.function?.name) === text(call?.function?.name) &&
          projection.call?.function?.arguments === call?.function?.arguments)
      );
      if (duplicate) continue;
      const projection = { pair, call };
      projections.push(projection);
      if (callId) {
        const items = projectionsByCallId.get(callId) || [];
        items.push(projection);
        projectionsByCallId.set(callId, items);
      }
    }
    if (projections.length > 0) projectionsByPair.set(pair, projections);
  }

  let matchedToolResults = 0;
  let toolResultBodies = 0;
  let toolCallErrors = 0;
  const matchedResultProjections = new Set<ToolProjection>();
  const errorResultProjections = new Set<ToolProjection>();
  for (const event of events.filter((item) => actionKind(item) === 'llm.tool_result')) {
    const parentToolSpanId = linkedParentSpanId(event, 'llm.tool_call.result');
    let projection = parentToolSpanId ? projectionBySpanId.get(parentToolSpanId) : undefined;
    const bindingState = text(event.attributes?.['llm.tool_result.binding_state']);
    const callId = text(event.attributes?.['llm.tool_result.id']);
    if (!projection && bindingState === 'bound' && callId) {
      const candidates = projectionsByCallId.get(callId) || [];
      if (candidates.length === 1) projection = candidates[0];
    }
    if (!projection) continue;

    matchedToolResults += 1;
    matchedResultProjections.add(projection);
    const output = toolResultContent(event);
    const isError = isTruthy(event.attributes?.['llm.tool_result.is_error']);
    projection.call.state = isError ? 'error' : 'completed';
    projection.call.timing = {
      ...projection.call.timing,
      completed_at: toIso(eventEndMs(event) || event.startTimeMs),
    };
    if (output !== undefined) {
      projection.call.output = output;
      projection.call.result = output;
      toolResultBodies += 1;
    }
    if (isError) {
      toolCallErrors += 1;
      errorResultProjections.add(projection);
    }
  }

  const canonicalResultsByCallId = new Map<string, CanonicalToolResult>();
  for (const pair of pairs) {
    for (const result of canonicalToolResults(pair)) {
      if (!canonicalResultsByCallId.has(result.callId)) {
        canonicalResultsByCallId.set(result.callId, result);
      }
    }
  }
  for (const result of canonicalResultsByCallId.values()) {
    const candidates = projectionsByCallId.get(result.callId) || [];
    if (candidates.length !== 1) continue;
    const projection = candidates[0];
    if (!matchedResultProjections.has(projection)) {
      matchedToolResults += 1;
      matchedResultProjections.add(projection);
    }
    projection.call.state = result.isError ? 'error' : 'completed';
    projection.call.timing = {
      ...projection.call.timing,
      completed_at: toIso(result.observedAtMs),
    };
    if (projection.call.output === undefined && projection.call.result === undefined) {
      projection.call.output = result.output;
      projection.call.result = result.output;
      toolResultBodies += 1;
    }
    if (result.isError && !errorResultProjections.has(projection)) {
      toolCallErrors += 1;
      errorResultProjections.add(projection);
    }
  }

  const ownersByInvocationSpanId = new Map<string, SubagentOwner>();
  const ownersByInvocationActionId = new Map<string, SubagentOwner>();
  let linkedSubagentInvocations = 0;
  for (const event of events.filter((item) => actionKind(item) === 'agent.invocation')) {
    const toolSpanId = linkedParentSpanId(event, 'llm.tool_call.agent_invocation');
    const toolActionId = text(event.attributes?.['agent.invocation.tool_call_action_id']);
    const toolCallId = text(event.attributes?.['agent.invocation.tool_call_id']);
    let projection = toolSpanId ? projectionBySpanId.get(toolSpanId) : undefined;
    if (!projection && toolActionId) {
      const candidates = projectionsByActionId.get(toolActionId) || [];
      if (candidates.length === 1) projection = candidates[0];
    }
    if (!projection && toolCallId) {
      const candidates = projectionsByCallId.get(toolCallId) || [];
      if (candidates.length === 1) projection = candidates[0];
    }

    const originalToolName = text(event.attributes?.['agent.invocation.tool_name']) ||
      text(projection?.call?.function?.name) ||
      'task';
    const agentType = text(event.attributes?.['agent.invocation.agent_type']) || originalToolName;
    const owner: SubagentOwner = {
      sessionId: event.spanId || actionId(event) || toolCallId || originalToolName,
      name: agentType,
      type: agentType,
    };
    if (event.spanId) ownersByInvocationSpanId.set(event.spanId, owner);
    const invocationActionId = actionId(event);
    if (invocationActionId) ownersByInvocationActionId.set(invocationActionId, owner);

    if (projection) {
      const args = parsedArguments(projection.call);
      projection.call.function = {
        ...(projection.call.function || {}),
        name: 'task',
        arguments: JSON.stringify({
          ...args,
          subagent_type: agentType,
          session_id: owner.sessionId,
          actrail_tool_name: originalToolName,
        }),
      };
      linkedSubagentInvocations += 1;
    }
  }

  const pairOwners = new Map<LlmPair, SubagentOwner>();
  for (const pair of pairs) {
    if (!pair.request) continue;
    const invocationSpanId = linkedParentSpanId(pair.request, 'agent.invocation.child_llm_request');
    const invocationActionId = text(pair.request.attributes?.['agent.invocation.action_id']);
    const owner = (invocationSpanId ? ownersByInvocationSpanId.get(invocationSpanId) : undefined) ||
      (invocationActionId ? ownersByInvocationActionId.get(invocationActionId) : undefined);
    if (owner) pairOwners.set(pair, owner);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const pair of pairs) {
      if (!pair.request || pairOwners.has(pair)) continue;
      const parentRequestSpanId = linkedParentSpanId(pair.request, 'llm.request.trajectory_parent') ||
        linkedParentSpanId(pair.request, 'llm.request.trajectory_fork');
      const parentPair = parentRequestSpanId ? pairByRequestSpanId.get(parentRequestSpanId) : undefined;
      const owner = parentPair ? pairOwners.get(parentPair) : undefined;
      if (!owner) continue;
      pairOwners.set(pair, owner);
      changed = true;
    }
  }

  return {
    toolCallsByPair: new Map(
      [...projectionsByPair.entries()].map(([pair, projections]) => [
        pair,
        projections.map((projection) => projection.call),
      ]),
    ),
    pairOwners,
    matchedToolResults,
    toolResultBodies,
    toolCallErrors,
    linkedSubagentInvocations,
  };
}

export function aggregateActrailTraceEvents(
  sessionId: string,
  events: OtelTraceEvent[],
): ExecutionRecord | null {
  const ordered = events
    .filter((event) => event.sessionId === sessionId)
    .sort((left, right) => left.startTimeMs - right.startTimeMs);
  if (ordered.length === 0) return null;

  const allPairs = buildLlmPairs(ordered);
  const pairs = allPairs.filter((pair) => !isInternalLlmPair(pair));
  if (pairs.length === 0) return null;

  const agentName = selectAgentName(ordered);
  const graph = buildActrailGraphProjection(ordered, pairs);
  const rootPairs = pairs.filter((pair) => !graph.pairOwners.has(pair));
  const promptSelection = rootPromptSelection(rootPairs.length > 0 ? rootPairs : pairs);
  const titlePrompt = primaryTitlePrompt(allPairs);
  const topLevelPrompts = titlePrompt ? new Set<string>() : promptSelection.prompts;
  const emittedPrompts = new Set<string>();
  const interactions: AnyObject[] = [];
  const allToolCalls: AnyObject[] = [];

  if (titlePrompt) {
    const firstPair = rootPairs[0] || pairs[0];
    const startedAt = pairStartMs(firstPair);
    interactions.push({
      role: 'user',
      content: titlePrompt,
      agent: agentName,
      timestamp: toIso(startedAt),
      timeInfo: {
        created: toIso(startedAt),
        completed: toIso(startedAt),
      },
      traceId: firstPair.call.traceId,
      spanId: (firstPair.call.spanId || actionId(firstPair.call) || 'llm') + ':input',
    });
  }

  for (const pair of pairs) {
    const prompt = pairPrompt(pair);
    const requestMessages = canonicalRequestMessages(pair);
    const owner = graph.pairOwners.get(pair);
    const startedAt = pairStartMs(pair);
    const completedAt = pairEndMs(pair);

    if (!owner && prompt && topLevelPrompts.has(prompt) && !emittedPrompts.has(prompt)) {
      emittedPrompts.add(prompt);
      interactions.push({
        role: 'user',
        content: prompt,
        agent: agentName,
        timestamp: toIso(startedAt),
        timeInfo: {
          created: toIso(startedAt),
          completed: toIso(startedAt),
        },
        traceId: pair.call.traceId,
        spanId: `${pair.call.spanId || actionId(pair.call) || 'llm'}:input`,
      });
    }

    const responseContent = text(pair.response?.attributes?.['llm.response.content_text']) || '';
    const reasoning = text(pair.response?.attributes?.['llm.response.reasoning_text']);
    const toolCalls = graph.toolCallsByPair.get(pair) || [];
    allToolCalls.push(...toolCalls);
    const usage = usageFrom(pair.response);
    const status = text(pair.call.attributes?.['actrail.action.status']);
    const errorMessage = status === 'error'
      ? llmCallErrorMessage(pair)
      : undefined;

    interactions.push({
      role: owner ? 'subagent' : 'assistant',
      content: responseContent,
      agent: owner?.name || agentName,
      subagent_name: owner?.name,
      subagent_type: owner?.type,
      subagent_session_id: owner?.sessionId,
      model: pair.call.model || pair.response?.model || pair.request?.model,
      provider: text(pair.response?.attributes?.['llm.response.provider_id']),
      timestamp: toIso(startedAt),
      timeInfo: {
        created: toIso(startedAt),
        completed: toIso(completedAt),
      },
      traceId: pair.call.traceId,
      spanId: pair.call.spanId,
      parentSpanId: pair.call.parentSpanId,
      name: pair.call.name,
      requestMessages: requestMessages.length > 0
        ? requestMessages
        : prompt ? [{ role: 'user', content: prompt }] : undefined,
      usage,
      parts: reasoning ? [{ type: 'reasoning', text: reasoning }] : undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      ...(errorMessage ? { status: 'error', error: { message: errorMessage } } : {}),
    });
  }

  const responses = pairs.map((pair) => pair.response).filter(Boolean) as OtelTraceEvent[];
  const totalUsage = responses.reduce(
    (sum, response) => ({
      input: sum.input + response.usage.input_tokens,
      output: sum.output + response.usage.output_tokens,
      reasoning: sum.reasoning + (response.usage.reasoning_tokens || 0),
      total: sum.total + response.usage.total_tokens,
    }),
    { input: 0, output: 0, reasoning: 0, total: 0 },
  );
  const firstEvent = ordered[0];
  const traceStartedAt = Math.min(...pairs.map(pairStartMs));
  const traceCompletedAt = Math.max(...pairs.map(pairEndMs));
  const finalResult = [...interactions]
    .reverse()
    .find((interaction) => interaction.role === 'assistant' && text(interaction.content))
    ?.content || '';
  const query = titlePrompt ||
    interactions.find((interaction) => interaction.role === 'user')?.content ||
    pairPrompt(rootPairs[0] || pairs[0]) ||
    'AcTrail Session';
  const invokedSkills = skillCalls(allToolCalls);
  const actionCounts = ordered.reduce<Record<string, number>>((counts, event) => {
    const kind = actionKind(event) || 'unknown';
    counts[kind] = (counts[kind] || 0) + 1;
    return counts;
  }, {});
  const unmatchedResponses = ordered.filter((event) =>
    actionKind(event) === 'llm.response' &&
    !allPairs.some((pair) => pair.response === event)
  ).length;

  return {
    task_id: sessionId,
    query,
    framework: 'actrail',
    model: pairs.map((pair) => pair.call.model || pair.response?.model).find(Boolean) || 'unknown',
    tokens: totalUsage.total,
    latency: Math.max(0, traceCompletedAt - traceStartedAt) / 1000,
    final_result: finalResult,
    trace_started_at: toIso(traceStartedAt),
    trace_completed_at: finalResult ? toIso(traceCompletedAt) : undefined,
    timestamp: new Date(traceStartedAt),
    label: 'AcTrail',
    user: firstEvent.user || 'anonymous',
    interactions,
    agent: agentName,
    agentName,
    llm_call_count: pairs.length,
    tool_call_count: allToolCalls.length,
    tool_call_error_count: graph.toolCallErrors,
    input_tokens: totalUsage.input,
    output_tokens: totalUsage.output,
    reasoning_tokens: totalUsage.reasoning || undefined,
    skills: invokedSkills.map((skill) => skill.name),
    invokedSkills,
    actrail_summary: {
      traceId: firstEvent.traceId,
      displayName: text(firstEvent.attributes?.['actrail.trace.display_name']),
      profileName: text(firstEvent.attributes?.['actrail.trace.profile_name']),
      scopeVersion: text(firstEvent.attributes?.['otel.scope.version']),
      actionCount: ordered.length,
      actionCounts,
      pairedLlmCalls: pairs.filter((pair) => pair.request && pair.response).length,
      internalLlmCallsFiltered: allPairs.length - pairs.length,
      unmatchedResponses,
      userTurnInference: titlePrompt ? 'title-generation-preview' : promptSelection.inference,
      inferredRootAgentSessionId: promptSelection.rootSessionId,
      observedAgentSessionCount: promptSelection.observedSessionCount,
      subagentTreeAvailable: graph.linkedSubagentInvocations > 0 && graph.pairOwners.size > 0,
      linkedSubagentInvocations: graph.linkedSubagentInvocations,
      subagentLlmCalls: graph.pairOwners.size,
      toolResultsAvailable: graph.matchedToolResults > 0,
      matchedToolResults: graph.matchedToolResults,
      toolResultBodies: graph.toolResultBodies,
    },
  };
}

export const actrailOtelTraceAdapter: OtelTraceAdapter = {
  id: 'actrail',
  matches: (events) => events.some((event) =>
    event.serviceName === 'actrail' ||
    event.attributes?.['otel.scope.name'] === 'actrail.semantic_actions' ||
    event.attributes?.['actrail.action.kind'] !== undefined
  ),
  aggregate: aggregateActrailTraceEvents,
};
