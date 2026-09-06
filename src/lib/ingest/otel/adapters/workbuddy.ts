import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

type AnyObj = Record<string, unknown>;

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() ? value : undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toIso(ms: number): string {
  return new Date(ms || Date.now()).toISOString();
}

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function spanType(event: OtelTraceEvent): string {
  return String(event.attributes?.['workbuddy.span.type'] || '').toLowerCase();
}

function isWorkBuddy(events: OtelTraceEvent[]): boolean {
  return events.some((event) => {
    const service = String(event.serviceName || '').toLowerCase();
    if (service === 'workbuddy') return true;
    const framework = String(event.attributes?.['agent.insight.framework'] || '').toLowerCase();
    if (framework === 'workbuddy') return true;
    return event.attributes?.['workbuddy.span.type'] !== undefined;
  });
}

function cacheTokens(event: OtelTraceEvent): number {
  const value = Number(event.attributes?.['workbuddy.cache_read_tokens']);
  return Number.isFinite(value) ? value : 0;
}

function toolCall(event: OtelTraceEvent): AnyObj {
  const attrs = event.attributes || {};
  const started = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = eventEndMs(event) || started;
  const name = firstText(attrs['tool.name'], event.name, 'tool') || 'tool';
  const args = parseJson(firstText(attrs['tool.arguments'], attrs['input.value']) || '{}');
  const output = firstText(attrs['tool.result'], attrs['output.value']);
  const isError = event.attributes?.['tool.outcome'] === 'error' ||
    String(attrs['tool.status'] || '').toLowerCase() === 'error';
  return {
    id: event.spanId,
    type: 'function',
    state: isError ? 'error' : 'success',
    original_tool_name: name,
    tool_type: 'function',
    function: { name, arguments: args },
    output,
    result: output,
    timing: { started_at: toIso(started), completed_at: toIso(completed) },
  };
}

export function aggregateWorkBuddyOtelTraceEvents(
  sessionId: string,
  allEvents: OtelTraceEvent[],
): ExecutionRecord | null {
  const events = allEvents.filter((event) => event.sessionId === sessionId);
  if (!events.length) return null;
  const ordered = [...events].sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));

  const rootEvents = ordered.filter((event) => spanType(event) === 'workflow');
  const llmEvents = ordered.filter((event) => spanType(event) === 'generation' || event.kind === 'llm');
  const toolEvents = ordered.filter((event) => {
    const type = spanType(event);
    // custom/mcp_tools 发现类 span 在采集端已剔除；这里只认真实工具调用。
    return type === 'function' || (!type && event.kind === 'tool');
  });

  const firstRoot = rootEvents[0];
  const firstEvent = firstRoot || ordered[0];
  const rootStarted = firstEvent.startTimeMs || Date.parse(firstEvent.receivedAt) || Date.now();
  const agentName = firstText(
    ordered.find((event) => spanType(event) === 'agent')?.attributes?.['workbuddy.agent.name'],
    'WorkBuddy',
  ) || 'WorkBuddy';

  const query = firstText(
    firstRoot?.attributes?.['workbuddy.user_prompt'],
    firstRoot?.attributes?.['input.value'],
    'WorkBuddy session',
  ) || 'WorkBuddy session';

  const interactions: AnyObj[] = [];
  const assistantBySpanId = new Map<string, AnyObj>();

  // 每个 root（一次 trace = 一轮对话）先落一条 user 交互，再挂该轮的 assistant / 工具。
  const emittedUserPrompts = new Set<string>();
  for (const root of rootEvents) {
    const prompt = firstText(root.attributes?.['workbuddy.user_prompt']);
    if (!prompt || emittedUserPrompts.has(root.traceId || root.spanId || prompt)) continue;
    emittedUserPrompts.add(root.traceId || root.spanId || prompt);
    interactions.push({
      role: 'user',
      content: prompt,
      agent: agentName,
      workbuddy_mode: firstText(root.attributes?.['workbuddy.mode']),
      timestamp: toIso(root.startTimeMs || rootStarted),
    });
  }

  const usageTotals = { input: 0, output: 0, reasoning: 0, total: 0, cache: 0 };
  for (const event of llmEvents) {
    const attrs = event.attributes || {};
    const started = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
    const completed = eventEndMs(event) || started;
    const input = event.usage.input_tokens || 0;
    const output = event.usage.output_tokens || 0;
    const reasoning = event.usage.reasoning_tokens || 0;
    const total = event.usage.total_tokens || input + output + reasoning;
    const cache = cacheTokens(event);
    usageTotals.input += input;
    usageTotals.output += output;
    usageTotals.reasoning += reasoning;
    usageTotals.total += total;
    usageTotals.cache += cache;
    const interaction: AnyObj = {
      role: 'assistant',
      content: firstText(attrs['output.value'], '') || '',
      model: firstText(event.model, attrs['llm.model_name'], 'unknown'),
      providerID: 'workbuddy',
      usage: {
        input_tokens: input,
        output_tokens: output,
        reasoning_tokens: reasoning || undefined,
        cache_read_tokens: cache || undefined,
        total,
      },
      timestamp: toIso(started),
      timeInfo: { created: toIso(started), completed: toIso(completed) },
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      traceId: event.traceId,
      agent: agentName,
    };
    const promptInput = firstText(attrs['input.value']);
    if (promptInput) interaction.requestMessages = [{ role: 'user', content: promptInput }];
    interactions.push(interaction);
    if (event.spanId) assistantBySpanId.set(event.spanId, interaction);
  }

  for (const event of toolEvents) {
    const call = toolCall(event);
    const host = (event.parentSpanId ? assistantBySpanId.get(event.parentSpanId) : undefined) ||
      [...interactions].reverse().find((interaction) => interaction.role === 'assistant');
    if (host) {
      host.tool_calls = Array.isArray(host.tool_calls) ? [...host.tool_calls, call] : [call];
    } else {
      interactions.push({
        role: 'assistant',
        content: '',
        agent: agentName,
        timestamp: toIso(event.startTimeMs || Date.parse(event.receivedAt) || Date.now()),
        tool_calls: [call],
      });
    }
  }

  // 工具已挂到各自的 assistant（嵌套），顶层交互按时间戳排序，让多轮 user/assistant 正确交错。
  interactions.sort((a, b) => Date.parse(String(a.timestamp || '')) - Date.parse(String(b.timestamp || '')));

  const modelEvent = [...llmEvents].reverse().find((event) => firstText(event.model, event.attributes?.['llm.model_name']));
  const finalResult = firstText(
    [...interactions].reverse().find((item) => item.role === 'assistant' && item.content)?.content,
    '',
  ) || '';
  const latencyMs = Math.max(
    0,
    ...ordered.map((event) => (spanType(event) === 'workflow' ? event.latencyMs || 0 : 0)),
    eventEndMs(ordered[ordered.length - 1]) - rootStarted,
  );

  // token 语义分层，如实表达 —— 不用会话级总量冒充逐轮值，也不估算：
  // - tokens / input_tokens / output_tokens：来自各 generation 的真实精确 usage 汇总
  // - context_window_limit：来自 D4 session_usage.size（上下文窗口上限）
  // - workbuddy_session_context_tokens：D4 session_usage.used（当前上下文占用快照，非本次累计）
  const sessionContextTokens = Number(firstRoot?.attributes?.['workbuddy.session.total_tokens']);
  const contextWindow = Number(firstRoot?.attributes?.['workbuddy.context_window']);
  const hasPerCallUsage = usageTotals.total > 0;

  return {
    task_id: sessionId,
    query,
    framework: 'workbuddy',
    model: firstText(modelEvent?.model, modelEvent?.attributes?.['llm.model_name'], 'unknown'),
    tokens: hasPerCallUsage ? usageTotals.total : undefined,
    input_tokens: hasPerCallUsage ? usageTotals.input : undefined,
    output_tokens: hasPerCallUsage ? usageTotals.output : undefined,
    reasoning_tokens: hasPerCallUsage && usageTotals.reasoning ? usageTotals.reasoning : undefined,
    cache_read_input_tokens: hasPerCallUsage && usageTotals.cache ? usageTotals.cache : undefined,
    context_window_limit: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
    context_window_source: Number.isFinite(sessionContextTokens) ? 'workbuddy_local_sqlite' : undefined,
    workbuddy_session_context_tokens: Number.isFinite(sessionContextTokens) ? sessionContextTokens : undefined,
    latency: latencyMs / 1000,
    final_result: finalResult,
    timestamp: new Date(rootStarted),
    label: agentName,
    // normalizeOtlpTraces 已用认证 API-key 归属覆盖客户端属性；此处保留其结果。
    user: firstEvent.user || 'anonymous',
    authenticated_ingest: ordered.some((event) => event.authenticatedUser === true),
    interactions,
    agent: agentName,
    agentName,
    llm_call_count: llmEvents.length,
    tool_call_count: toolEvents.length,
    tool_call_error_count: toolEvents.filter((event) => {
      return event.attributes?.['tool.outcome'] === 'error' ||
        String(event.attributes?.['tool.status'] || '').toLowerCase() === 'error';
    }).length,
  };
}

export const workbuddyOtelTraceAdapter: OtelTraceAdapter = {
  id: 'workbuddy',
  matches: isWorkBuddy,
  aggregate: aggregateWorkBuddyOtelTraceEvents,
};
