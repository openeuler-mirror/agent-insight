import type { OtelTraceEvent } from '../types';

export type LangfuseTraceNodeKind = 'llm' | 'tool' | 'agent' | 'chain' | 'span';

export interface LangfuseTraceNode {
  traceId: string;
  spanId: string;
  subagentSessionId?: string;
  parentSpanId: string | null;
  sourceParentSpanId: string | null;
  displayParentSpanId: string | null;
  name: string;
  kind: LangfuseTraceNodeKind;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  input?: unknown;
  output?: unknown;
  status: 'success' | 'error' | 'unset';
  statusMessage?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    totalTokens?: number;
  };
  visibility: 'visible' | 'collapsed';
  collapseReason?: string;
  toolCallId?: string;
  linkedGenerationSpanId?: string;
  orphanTool?: boolean;
}

export interface LangfuseRequestMessage {
  role: string;
  content: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
}

export function langfuseSubagentSessionId(rootSessionId: string, spanId: string): string {
  return `${rootSessionId}:subagent:${spanId}`;
}

const LANGFUSE_LANGGRAPH_WRAPPERS = new Set([
  'langgraph',
  'model',
  'tools',
  'agent',
  'prompt',
  'runnablesequence',
  'call_model',
  'should_continue',
  'retrievalsession.as_tools',
]);

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function attr(event: OtelTraceEvent, key: string): unknown {
  return event.attributes?.[key];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const REQUEST_MESSAGE_MAX_CHARS = 4_000;
const REQUEST_MESSAGES_MAX_COUNT = 60;

function requestMessageRole(value: unknown): string {
  const role = String(value || 'user').trim().toLowerCase();
  if (role === 'human') return 'user';
  if (role === 'ai') return 'assistant';
  return role || 'user';
}

function requestMessageContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function isToolDefinitionMessage(message: Record<string, unknown>, role: string): boolean {
  if (role !== 'tool' || text(message.tool_call_id)) return false;
  const content = parseJson(message.content);
  if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
  const definition = content as Record<string, unknown>;
  const fn = definition.function;
  if (String(definition.type || '').toLowerCase() !== 'function' || !fn || typeof fn !== 'object' || Array.isArray(fn)) {
    return false;
  }
  const functionDefinition = fn as Record<string, unknown>;
  return !!text(functionDefinition.name)
    && (text(functionDefinition.description) != null || functionDefinition.parameters != null);
}

export function normalizeLangfuseRequestMessages(value: unknown): LangfuseRequestMessage[] {
  const parsed = parseJson(value) as Record<string, unknown> | unknown[] | undefined;
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray(parsed.messages)
      ? parsed.messages
      : [];
  let messages: LangfuseRequestMessage[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const message = item as Record<string, unknown>;
    const role = requestMessageRole(message.role ?? message.type);
    if (isToolDefinitionMessage(message, role)) continue;
    const content = requestMessageContent(message.content);
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
    const toolCallId = text(message.tool_call_id);
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

function toolCallIdFromEvent(event: OtelTraceEvent): string | undefined {
  const input = parseJson(attr(event, 'langfuse.observation.input')) as Record<string, unknown> | undefined;
  const output = parseJson(attr(event, 'langfuse.observation.output')) as Record<string, unknown> | undefined;
  return text(attr(event, 'langfuse.observation.metadata.tool_call_id'))
    || text(input?.tool_call_id)
    || text(output?.tool_call_id);
}

function generationToolCallIds(event: OtelTraceEvent): Set<string> {
  const output = parseJson(attr(event, 'langfuse.observation.output')) as Record<string, unknown> | undefined;
  const additional = output?.additional_kwargs && typeof output.additional_kwargs === 'object'
    ? output.additional_kwargs as Record<string, unknown>
    : undefined;
  const calls = Array.isArray(output?.tool_calls)
    ? output.tool_calls
    : Array.isArray(additional?.tool_calls)
      ? additional.tool_calls
      : [];
  return new Set(calls
    .map((call: unknown) => call && typeof call === 'object' ? text((call as Record<string, unknown>).id) : undefined)
    .filter((id: string | undefined): id is string => !!id));
}

function nodeStatus(event: OtelTraceEvent): LangfuseTraceNode['status'] {
  const level = String(attr(event, 'langfuse.observation.level') || '').toLowerCase();
  if (level === 'error') return 'error';
  if (level === 'warning' || level === 'warn') return 'unset';
  return 'success';
}

function isFrameworkWrapper(event: OtelTraceEvent): boolean {
  return LANGFUSE_LANGGRAPH_WRAPPERS.has(String(event.name || '').trim().toLowerCase());
}

function hasMeaningfulContent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function nearestVisibleParent(
  parentSpanId: string | undefined,
  nodesById: Map<string, LangfuseTraceNode>,
): string | null {
  let currentId = parentSpanId;
  const seen = new Set<string>();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const parent = nodesById.get(currentId);
    if (!parent) return null;
    if (parent.visibility === 'visible') return parent.spanId;
    currentId = parent.sourceParentSpanId || undefined;
  }
  return null;
}

export function buildLangfuseTraceNodes(events: OtelTraceEvent[]): LangfuseTraceNode[] {
  const ordered = [...events]
    .filter((event) => event.spanId && event.traceId)
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  const parentSpanIds = new Set(ordered.map(event => event.parentSpanId).filter((id): id is string => !!id));
  const generationByToolCallId = new Map<string, string>();
  for (const event of ordered) {
    if (event.kind !== 'llm' || !event.spanId) continue;
    for (const callId of generationToolCallIds(event)) generationByToolCallId.set(callId, event.spanId);
  }

  const nodes = ordered.map((event): LangfuseTraceNode => {
    const startedAt = event.startTimeMs || Date.parse(event.receivedAt || '') || 0;
    const durationMs = Math.max(0, event.latencyMs || 0);
    const status = nodeStatus(event);
    const input = parseJson(attr(event, 'langfuse.observation.input'));
    const output = parseJson(attr(event, 'langfuse.observation.output'));
    const hasChildren = parentSpanIds.has(event.spanId as string);
    const collapsed = isFrameworkWrapper(event)
      && status !== 'error'
      && (hasChildren || (!hasMeaningfulContent(input) && !hasMeaningfulContent(output)));
    const toolCallId = event.kind === 'tool' ? toolCallIdFromEvent(event) : undefined;
    const linkedGenerationSpanId = toolCallId ? generationByToolCallId.get(toolCallId) : undefined;
    return {
      traceId: event.traceId as string,
      spanId: event.spanId as string,
      parentSpanId: event.parentSpanId || null,
      sourceParentSpanId: event.parentSpanId || null,
      displayParentSpanId: event.parentSpanId || null,
      name: event.name || event.kind,
      kind: event.kind,
      startedAt,
      completedAt: startedAt + durationMs,
      durationMs,
      input,
      output,
      status,
      statusMessage: text(attr(event, 'langfuse.observation.status_message')),
      model: event.model,
      usage: event.kind === 'llm' ? {
        inputTokens: event.usage.input_tokens,
        outputTokens: event.usage.output_tokens,
        reasoningTokens: event.usage.reasoning_tokens,
        totalTokens: event.usage.total_tokens,
      } : undefined,
      visibility: collapsed ? 'collapsed' : 'visible',
      collapseReason: collapsed ? 'langgraph-framework-wrapper' : undefined,
      toolCallId,
      linkedGenerationSpanId,
      orphanTool: event.kind === 'tool' ? !linkedGenerationSpanId : undefined,
    };
  });

  const nodesById = new Map(nodes.map((node) => [node.spanId, node]));
  for (const node of nodes) {
    node.displayParentSpanId = nearestVisibleParent(node.sourceParentSpanId || undefined, nodesById);
  }
  return nodes;
}

export function mergeLangfuseTraceNodes(
  previous: LangfuseTraceNode[],
  incoming: LangfuseTraceNode[],
): LangfuseTraceNode[] {
  const nodesById = new Map(previous.map((node) => [node.spanId, node]));
  for (const node of incoming) nodesById.set(node.spanId, { ...nodesById.get(node.spanId), ...node });
  return [...nodesById.values()].sort((a, b) => a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId));
}
