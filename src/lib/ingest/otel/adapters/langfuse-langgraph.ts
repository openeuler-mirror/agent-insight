import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';
import { LANGFUSE_LANGGRAPH_FRAMEWORK } from '../langfuse';
import type { OtelTraceAdapter } from './types';

type AnyObj = Record<string, any>;
const DEFAULT_REPORT_SUBAGENT = 'report-generator';
const INTERNAL_LANGGRAPH_NAMES = new Set([
  'agent',
  'tools',
  'prompt',
  'runnablesequence',
  'call_model',
  'should_continue',
  'chatopenai',
  'langgraph',
]);

function text(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.trim() ? value : undefined;
  try {
    const out = JSON.stringify(value);
    return out && out !== 'null' ? out : undefined;
  } catch {
    return String(value);
  }
}

function parseJson(value: any): any {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s) return value;
  try {
    return JSON.parse(s);
  } catch {
    return value;
  }
}

function objectFromJson(value: any): AnyObj {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function firstText(...values: any[]): string | undefined {
  for (const value of values) {
    const out = text(value);
    if (out) return out;
  }
  return undefined;
}

function attr(event: OtelTraceEvent | undefined, key: string): any {
  return event?.attributes?.[key];
}

function eventStart(event: OtelTraceEvent | undefined): number {
  return event?.startTimeMs || Date.parse(event?.receivedAt || '') || Date.now();
}

function eventEnd(event: OtelTraceEvent | undefined): number {
  return eventStart(event) + Math.max(0, event?.latencyMs || 0);
}

function toIso(ms: number): string {
  return new Date(ms || Date.now()).toISOString();
}

function tokenTotal(event: OtelTraceEvent): number {
  return event.usage.total_tokens ||
    event.usage.input_tokens + event.usage.output_tokens + (event.usage.reasoning_tokens || 0);
}

function rootInput(root: OtelTraceEvent | undefined): AnyObj {
  return objectFromJson(attr(root, 'langfuse.observation.input'));
}

function rootOutput(root: OtelTraceEvent | undefined): AnyObj {
  return objectFromJson(attr(root, 'langfuse.observation.output'));
}

function metadata(event: OtelTraceEvent | undefined, key: string): string | undefined {
  return firstText(
    attr(event, `langfuse.observation.metadata.${key}`),
    attr(event, `langfuse.trace.metadata.${key}`),
  );
}

function stableSubagentSession(sessionId: string, tool: OtelTraceEvent | undefined): string {
  return `${sessionId}:subagent:${tool?.spanId || DEFAULT_REPORT_SUBAGENT}`;
}

function hasAncestor(event: OtelTraceEvent, byId: Map<string, OtelTraceEvent>, predicate: (event: OtelTraceEvent) => boolean): boolean {
  let current = event.parentSpanId ? byId.get(event.parentSpanId) : undefined;
  const seen = new Set<string>();
  while (current?.spanId && !seen.has(current.spanId)) {
    if (predicate(current)) return true;
    seen.add(current.spanId);
    current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
  }
  return false;
}

function parsedGenerationOutput(event: OtelTraceEvent): AnyObj {
  return objectFromJson(attr(event, 'langfuse.observation.output'));
}

function parsedToolOutput(event: OtelTraceEvent): any {
  return parseJson(attr(event, 'langfuse.observation.output'));
}

function toolCallArgs(call: AnyObj): AnyObj {
  return call?.args && typeof call.args === 'object' && !Array.isArray(call.args) ? call.args : {};
}

function subagentNameFromArgs(args: AnyObj): string | undefined {
  return firstText(
    args.subagent_type,
    args.subagent_name,
    args.subagentName,
    args.agent,
    args.agent_name,
    args.agentName,
    args.name,
  );
}

function subagentNameFromTool(tool: OtelTraceEvent | undefined): string | undefined {
  return subagentNameFromArgs(objectFromJson(attr(tool, 'langfuse.observation.input')));
}

function userMessageText(message: any): string | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined;
  const role = String(message.role ?? message.type ?? '').toLowerCase();
  if (role !== 'user' && role !== 'human') return undefined;
  return text(message.content);
}

// 在应用私有的 root input 结构里深挖「最后一条用户消息」作为 query。
// 兼容 {messages:[...]}（LangChain 序列化，type=human）与 {request:{history:[...]}}（业务网关，role=user）
// 等嵌套结构；数组从后往前找，保证多轮会话取的是当前这一轮的问题。
function lastUserMessageText(value: any, depth = 0): string | undefined {
  if (value == null || depth > 8) return undefined;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; i--) {
      const hit = userMessageText(value[i]) ?? lastUserMessageText(value[i], depth + 1);
      if (hit) return hit;
    }
    return undefined;
  }
  if (typeof value !== 'object') return undefined;
  for (const key of ['history', 'messages']) {
    const hit = lastUserMessageText((value as AnyObj)[key], depth + 1);
    if (hit) return hit;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === 'history' || key === 'messages') continue;
    const hit = lastUserMessageText(child, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

function normalizeToolCall(
  call: AnyObj,
  skillName: string | undefined,
  subagentSessionId: string | undefined,
  subagentName: string,
): AnyObj {
  const rawName = firstText(call.name, call.function?.name) || 'tool';
  const args = toolCallArgs(call);

  if (rawName === 'follow_skill' && skillName) {
    return {
      id: call.id,
      type: 'function',
      state: 'pending',
      function: {
        name: 'skill',
        arguments: JSON.stringify({ name: skillName, source_tool: rawName, ...args }),
      },
    };
  }

  if (rawName === 'call_report_subagent') {
    return {
      id: call.id,
      type: 'function',
      state: 'pending',
      function: {
        name: 'task',
        arguments: JSON.stringify({
          subagent_type: subagentNameFromArgs(args) || subagentName,
          description: firstText(args.diagnosis_summary, args.description) || 'generate diagnostic report',
          source_tool: rawName,
          subagent_session_id: subagentSessionId,
        }),
      },
    };
  }

  return {
    id: call.id,
    type: 'function',
    state: 'pending',
    function: {
      name: rawName,
      arguments: JSON.stringify(args),
    },
  };
}

function parsedArguments(call: AnyObj): AnyObj {
  const value = call?.function?.arguments ?? call?.arguments;
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function callMatchesTool(call: AnyObj, toolName: string | undefined): boolean {
  const name = call?.function?.name || call?.name;
  const args = parsedArguments(call);
  if (toolName === 'follow_skill') return name === 'skill' && args.source_tool === 'follow_skill';
  if (toolName === 'call_report_subagent') return name === 'task' && args.source_tool === 'call_report_subagent';
  return name === toolName;
}

function attachToolOutputs(interactions: AnyObj[], toolEvents: OtelTraceEvent[]): void {
  const used = new Set<string>();
  for (const tool of toolEvents.sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0))) {
    for (const interaction of interactions) {
      const calls = Array.isArray(interaction.tool_calls) ? interaction.tool_calls : [];
      const call = calls.find((item: AnyObj) => {
        const key = `${tool.spanId || tool.name}:${item.id || item.function?.name}`;
        return !used.has(key) && callMatchesTool(item, tool.name);
      });
      if (!call) continue;
      const key = `${tool.spanId || tool.name}:${call.id || call.function?.name}`;
      used.add(key);
      const output = parsedToolOutput(tool);
      call.state = 'success';
      call.output = output;
      call.result = output;
      call.timing = {
        started_at: toIso(eventStart(tool)),
        completed_at: toIso(eventEnd(tool)),
      };
      break;
    }
  }
}

function usage(event: OtelTraceEvent) {
  return {
    input: event.usage.input_tokens,
    output: event.usage.output_tokens,
    reasoning: event.usage.reasoning_tokens || undefined,
    total: event.usage.total_tokens,
  };
}

function interactionFromGeneration(args: {
  event: OtelTraceEvent;
  skillName?: string;
  mainAgentName: string;
  isSubagent: boolean;
  subagentSessionId?: string;
  subagentName: string;
}): AnyObj {
  const { event, skillName, mainAgentName, isSubagent, subagentSessionId, subagentName } = args;
  const output = parsedGenerationOutput(event);
  const created = eventStart(event);
  const completed = eventEnd(event);
  const toolCalls = Array.isArray(output.tool_calls)
    ? output.tool_calls.map((call: AnyObj) => normalizeToolCall(call, skillName, subagentSessionId, subagentName))
    : [];
  const interaction: AnyObj = {
    role: isSubagent ? 'subagent' : 'assistant',
    content: firstText(output.content, attr(event, 'langfuse.observation.output')) || '',
    agent: isSubagent ? subagentName : mainAgentName,
    model: event.model,
    usage: usage(event),
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    traceId: event.traceId,
    name: event.name,
    timestamp: toIso(created),
    timeInfo: { created: toIso(created), completed: toIso(completed) },
  };
  if (isSubagent) {
    interaction.subagent_name = subagentName;
    interaction.subagent_session_id = subagentSessionId;
  }
  if (toolCalls.length) interaction.tool_calls = toolCalls;
  return interaction;
}

function findRoot(events: OtelTraceEvent[]): OtelTraceEvent | undefined {
  const byLatestEnd = (items: OtelTraceEvent[]) =>
    [...items].sort((a, b) => eventEnd(b) - eventEnd(a))[0];
  const appRoot = byLatestEnd(events.filter((event) =>
    attr(event, 'langfuse.internal.is_app_root') === true ||
    attr(event, 'langfuse.internal.is_app_root') === 'true',
  ));
  if (appRoot) return appRoot;
  return byLatestEnd(events.filter((event) => event.kind === 'span')) || byLatestEnd(events);
}

function isSyntheticRunName(value: any): boolean {
  const name = firstText(value);
  return !!name && /^agent-run(?:[-_]\d{8}t\d{6}z?)?$/i.test(name);
}

function isBusinessAgentName(value: any): boolean {
  const name = firstText(value);
  if (!name || isSyntheticRunName(name)) return false;
  return !INTERNAL_LANGGRAPH_NAMES.has(name.toLowerCase());
}

function rootName(root: OtelTraceEvent | undefined): string | undefined {
  return isBusinessAgentName(root?.name) ? firstText(root?.name) : undefined;
}

function eventName(event: OtelTraceEvent | undefined): string | undefined {
  return isBusinessAgentName(event?.name) ? firstText(event?.name) : undefined;
}

function outputMessageNames(event: OtelTraceEvent | undefined): string[] {
  const parsed = parseJson(attr(event, 'langfuse.observation.output'));
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [parsed];
  return messages
    .map((message: AnyObj) => firstText(message?.name))
    .filter((name: string | undefined): name is string => isBusinessAgentName(name));
}

function graphSpanName(events: OtelTraceEvent[], isInScope: (event: OtelTraceEvent) => boolean): string | undefined {
  const candidates = events
    .filter(isInScope)
    .filter((event) => event.kind !== 'llm' && event.kind !== 'tool')
    .filter((event) => eventName(event))
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  return eventName(candidates[0]);
}

function outputAgentName(events: OtelTraceEvent[], isInScope: (event: OtelTraceEvent) => boolean): string | undefined {
  for (const event of events.filter(isInScope).sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0))) {
    const name = outputMessageNames(event)[0];
    if (name) return name;
  }
  return undefined;
}

function mainAgentName(
  root: OtelTraceEvent | undefined,
  input: AnyObj,
  events: OtelTraceEvent[],
  isUnderSubagent: (event: OtelTraceEvent) => boolean,
): string {
  const isMainScope = (event: OtelTraceEvent) => !isUnderSubagent(event);
  return firstText(
    input.agent,
    input.agent_name,
    input.agentName,
    metadata(root, 'agent'),
    metadata(root, 'agent_name'),
    metadata(root, 'agentName'),
    metadata(root, 'name'),
    graphSpanName(events, isMainScope),
    outputAgentName(events, isMainScope),
    rootName(root),
  ) || 'Langfuse Agent';
}

export function aggregateLangfuseLangGraphTraceEvents(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null {
  const sessionEvents = events
    .filter((event) => event.sessionId === sessionId)
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  if (!sessionEvents.length) return null;

  const selectedRoot = findRoot(sessionEvents);
  const selectedTraceId = selectedRoot?.traceId;
  const ordered = (selectedTraceId
    ? sessionEvents.filter((event) => event.traceId === selectedTraceId)
    : sessionEvents)
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  if (!ordered.length) return null;

  const byId = new Map(ordered.filter((event) => event.spanId).map((event) => [event.spanId as string, event]));
  const root = findRoot(ordered) || selectedRoot;
  const input = rootInput(root);
  const output = rootOutput(root);
  const skillName = firstText(
    input.skill,
    metadata(root, 'skill'),
    ordered.map((event) => metadata(event, 'skill')).find(Boolean),
  );
  // 子 agent 识别，两种机制并存：
  // 1) 通用：具名的 kind=agent span（LangGraph supervisor/多 agent 模式，如 query_agent、qa_agent）。
  //    要求非 root 且父 span 可解析，避免把单 agent 应用的顶层 agent span 误判成子 agent；
  //    内部结构节点（name='agent' 等 INTERNAL_LANGGRAPH_NAMES）由 isBusinessAgentName 过滤。
  // 2) 兼容旧路径：call_report_subagent 工具 span（demo/server-troubleshooter 形态）。
  const legacySubagentTool = ordered.find((event) => event.kind === 'tool' && event.name === 'call_report_subagent');
  const legacyIsUnder = (event: OtelTraceEvent) =>
    hasAncestor(event, byId, (ancestor) => ancestor.kind === 'tool' && ancestor.name === 'call_report_subagent');
  const legacySubagentName =
    subagentNameFromTool(legacySubagentTool) ||
    graphSpanName(ordered, legacyIsUnder) ||
    outputAgentName(ordered, legacyIsUnder) ||
    DEFAULT_REPORT_SUBAGENT;
  const legacySubagentSessionId = legacySubagentTool ? stableSubagentSession(sessionId, legacySubagentTool) : undefined;

  const subagentScopes = new Map<string, { name: string; sessionId: string }>();
  for (const span of ordered) {
    if (span.kind !== 'agent' || !span.spanId) continue;
    if (!isBusinessAgentName(span.name)) continue;
    if (span === root || !span.parentSpanId || !byId.has(span.parentSpanId)) continue;
    subagentScopes.set(span.spanId, {
      name: firstText(span.name) || DEFAULT_REPORT_SUBAGENT,
      sessionId: stableSubagentSession(sessionId, span),
    });
  }
  if (legacySubagentTool?.spanId && legacySubagentSessionId) {
    subagentScopes.set(legacySubagentTool.spanId, {
      name: legacySubagentName,
      sessionId: legacySubagentSessionId,
    });
  }

  // 就近原则：一个事件属于「最近的子 agent 祖先」的作用域
  const subagentScopeFor = (event: OtelTraceEvent): { name: string; sessionId: string } | undefined => {
    let current = event.parentSpanId ? byId.get(event.parentSpanId) : undefined;
    const seen = new Set<string>();
    while (current?.spanId && !seen.has(current.spanId)) {
      const scope = subagentScopes.get(current.spanId);
      if (scope) return scope;
      seen.add(current.spanId);
      current = current.parentSpanId ? byId.get(current.parentSpanId) : undefined;
    }
    return undefined;
  };
  const isUnderSubagent = (event: OtelTraceEvent) => !!subagentScopeFor(event);
  const agentName = mainAgentName(root, input, ordered, isUnderSubagent);

  // 任何 LLM 调用都算，不限定 chat model wrapper 的名字（ChatOpenAI / ChatDeepSeek / ChatTongyi …）。
  // kind === 'llm' 精确对应 Langfuse 的 observation.type === 'generation'，不会误纳入 chain/tool。
  const generationEvents = ordered.filter((event) => event.kind === 'llm');
  const interactions: AnyObj[] = [];
  const query = firstText(
    input.input,
    metadata(root, 'input'),
    // 应用私有 root input（如 {request:{history:[{role:'user',...}]}}）里深挖用户问题
    lastUserMessageText(input),
    // 再退一步：从第一个 LLM 调用的入参消息里找用户问题
    lastUserMessageText(parseJson(attr(generationEvents[0], 'langfuse.observation.input'))),
    attr(generationEvents[0], 'langfuse.trace.metadata.input'),
  ) || 'Langfuse LangGraph Session';
  interactions.push({
    role: 'user',
    content: query,
    agent: agentName,
    timestamp: toIso(eventStart(root)),
    timeInfo: { created: toIso(eventStart(root)) },
  });

  for (const event of generationEvents) {
    const scope = subagentScopeFor(event);
    interactions.push(interactionFromGeneration({
      event,
      skillName,
      mainAgentName: agentName,
      isSubagent: !!scope,
      // 主流程 generation 里若出现 call_report_subagent tool_call，仍用 legacy 会话 id 关联
      subagentSessionId: scope?.sessionId ?? legacySubagentSessionId,
      subagentName: scope?.name ?? legacySubagentName,
    }));
  }

  attachToolOutputs(interactions, ordered.filter((event) => event.kind === 'tool'));

  // 最终回复：优先 root 显式声明的 final_output；否则取时间上最后一个 generation 的内容——
  // supervisor 模式下最终回答往往出自某个子 agent（如 qa_agent），不能只看主流程。
  const lastGeneration = generationEvents[generationEvents.length - 1];
  const finalResult = firstText(
    output.final_output,
    lastGeneration ? parsedGenerationOutput(lastGeneration).content : undefined,
  ) || '';
  const usageEvents = generationEvents.filter((event) => tokenTotal(event) > 0);
  const modelEvent = generationEvents.find((event) => event.model);
  const start = Math.min(...ordered.map(eventStart));
  const end = Math.max(...ordered.map(eventEnd));
  const toolEvents = ordered.filter((event) => event.kind === 'tool');

  return {
    task_id: sessionId,
    query,
    framework: LANGFUSE_LANGGRAPH_FRAMEWORK,
    model: firstText(input.model, metadata(root, 'model'), modelEvent?.model) || 'unknown',
    tokens: usageEvents.reduce((sum, event) => sum + tokenTotal(event), 0),
    latency: Math.max(0, end - start),
    final_result: finalResult,
    timestamp: new Date(start || Date.now()),
    trace_completed_at: toIso(end),
    force_query_update: true,
    session_merge_strategy: 'snapshot-replace',
    label: LANGFUSE_LANGGRAPH_FRAMEWORK,
    user: ordered.find((event) => event.user)?.user || 'anonymous',
    interactions,
    skill: skillName,
    invokedSkills: skillName ? [{ name: skillName, version: null }] : [],
    skills: skillName ? [skillName] : [],
    agent: agentName,
    agentName,
    llm_call_count: generationEvents.length,
    tool_call_count: toolEvents.length,
    tool_call_error_count: toolEvents.filter((event) => String(attr(event, 'langfuse.observation.level') || '').toLowerCase() === 'error').length,
    input_tokens: usageEvents.reduce((sum, event) => sum + event.usage.input_tokens, 0),
    output_tokens: usageEvents.reduce((sum, event) => sum + event.usage.output_tokens, 0),
    reasoning_tokens: usageEvents.reduce((sum, event) => sum + (event.usage.reasoning_tokens || 0), 0) || undefined,
    subagentCount: subagentScopes.size,
  };
}

export const langfuseLangGraphOtelTraceAdapter: OtelTraceAdapter = {
  id: LANGFUSE_LANGGRAPH_FRAMEWORK,
  matches: (events) => events.some((event) => event.serviceName === LANGFUSE_LANGGRAPH_FRAMEWORK),
  aggregate: aggregateLangfuseLangGraphTraceEvents,
};
