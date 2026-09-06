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

// WorkBuddy 内部根 Agent 名是 "cli"（终端标题生成器等是内部工具 Agent）。
// 用户界面里对话的是「WorkBuddy」，因此把内部名归一化为产品名。
function workbuddyAgentName(raw: unknown): string {
  const name = String(raw || '').trim();
  if (!name || name.toLowerCase() === 'cli') return 'WorkBuddy';
  if (name === 'terminalTitleGenerator') return 'WorkBuddy';
  return name;
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

/** 从可能被截断的 JSON 字符串里正则抠出某个字符串字段（截断安全，用于长 prompt 场景）。 */
function matchJsonStringField(raw: string, field: string): string | undefined {
  const m = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
  if (!m) return undefined;
  try {
    return JSON.parse(`"${m[1]}"`);
  } catch {
    return m[1];
  }
}

/** WorkBuddy 派发子 Agent 的 "Agent" 工具：提取子 Agent 的展示名与类型。 */
function agentSpawnInfo(event: OtelTraceEvent): { name: string; subagentType?: string } {
  const attrs = event.attributes || {};
  const raw = String(attrs['tool.arguments'] ?? '');
  const parsed = parseJson(raw);
  const obj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AnyObj : {};
  // description 是子 Agent 的人类可读角色名（如「造门店运营数据」），位于参数最前，截断也基本保得住；
  // subagent_type（如 general-purpose）太通用，只作次要信息 / 兜底。
  const desc = firstText(obj.description) || matchJsonStringField(raw, 'description');
  const subType = firstText(obj.subagent_type) || matchJsonStringField(raw, 'subagent_type');
  return { name: desc || subType || '子 Agent', subagentType: subType };
}

function isAgentSpawnEvent(event: OtelTraceEvent): boolean {
  const name = String(firstText(event.attributes?.['tool.name'], event.name) || '');
  return name.toLowerCase() === 'agent';
}

function toolCall(event: OtelTraceEvent): AnyObj {
  const attrs = event.attributes || {};
  const started = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = eventEndMs(event) || started;
  const name = firstText(attrs['tool.name'], event.name, 'tool') || 'tool';
  const args = parseJson(firstText(attrs['tool.arguments'], attrs['input.value']) || '{}');
  const argObj = args && typeof args === 'object' && !Array.isArray(args) ? args as AnyObj : {};
  const output = firstText(attrs['tool.result'], attrs['output.value']);
  const isError = event.attributes?.['tool.outcome'] === 'error' ||
    String(attrs['tool.status'] || '').toLowerCase() === 'error';
  // WorkBuddy 派发子 Agent 是通过一个名为 "Agent" 的工具调用（参数含 subagent_type/prompt），
  // 语义上是子 Agent，不是普通工具。归一化成平台约定的 `task`，让链路树渲染为 Agent/子 Agent 节点
  // （buildAgentCallTree 认 function.name==='task' → kind:'task'，并读 args.subagent_type）。
  // 用工具名判定（截断安全）：长 prompt 可能把 arguments 截断到无法解析出 subagent_type，
  // 而 "Agent" 这个工具名本身就是子 Agent 派发的确定标志。
  const isAgentSpawn = name.toLowerCase() === 'agent' && (
    Boolean(argObj.subagent_type || argObj.subagentType)
    || /subagent_?type/i.test(String(attrs['tool.arguments'] ?? ''))
    || name === 'Agent'
  );
  return {
    id: event.spanId,
    type: 'function',
    state: isError ? 'error' : 'success',
    original_tool_name: name,
    tool_type: isAgentSpawn ? 'task' : 'function',
    function: { name: isAgentSpawn ? 'task' : name, arguments: args },
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
  const agentName = workbuddyAgentName(
    ordered.find((event) => spanType(event) === 'agent')?.attributes?.['workbuddy.agent.name'],
  );

  const query = firstText(
    firstRoot?.attributes?.['workbuddy.user_prompt'],
    firstRoot?.attributes?.['input.value'],
    'WorkBuddy session',
  ) || 'WorkBuddy session';

  const interactions: AnyObj[] = [];
  const assistantBySpanId = new Map<string, AnyObj>();
  // 记录每个 assistant 的起始时间，供工具按时间就近归属（WorkBuddy 的 function/generation
  // span 都平级挂在 agent 之下，工具与其对应的那次 LLM 之间没有父子链，只能靠时间还原）。
  const assistantsByStart: Array<{ interaction: AnyObj; startMs: number }> = [];

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
    assistantsByStart.push({ interaction, startMs: started });
  }

  // assistant 按起始时间升序，便于「就近上一次 LLM」归属。
  assistantsByStart.sort((a, b) => a.startMs - b.startMs);
  const hostForToolByTime = (toolStartMs: number): AnyObj | undefined => {
    let chosen: AnyObj | undefined;
    for (const entry of assistantsByStart) {
      if (entry.startMs <= toolStartMs) chosen = entry.interaction;
      else break;
    }
    return chosen || assistantsByStart[assistantsByStart.length - 1]?.interaction;
  };

  const subagentInteractions: AnyObj[] = [];
  for (const event of toolEvents) {
    const call = toolCall(event);
    const toolStartMs = event.startTimeMs || Date.parse(event.receivedAt) || 0;
    const toolEndMs = eventEndMs(event) || toolStartMs;
    const host = (event.parentSpanId ? assistantBySpanId.get(event.parentSpanId) : undefined) ||
      hostForToolByTime(toolStartMs);

    // 子 Agent 派发（"Agent" 工具）：既在父 assistant 上留一条 task 调用，
    // 又合成一条 role='subagent' 的子 Agent 交互，用 description 作为节点名，
    // 并用同一个 subagent_session_id 把父 task 与子 Agent 关联起来，让链路树渲染成
    // 一个正确命名的子 Agent 节点（而非无名的 general-purpose）。
    if (isAgentSpawnEvent(event)) {
      const info = agentSpawnInfo(event);
      const subSid = `wb-sub-${event.spanId || `${event.traceId || 'wb'}-${event.startTimeMs || 0}`}`;
      // 把 session id 注入 task 调用参数，供 buildAgentCallTree 关联父子。
      const fn = call.function as AnyObj | undefined;
      if (fn) {
        if (fn.arguments && typeof fn.arguments === 'object' && !Array.isArray(fn.arguments)) {
          (fn.arguments as AnyObj).subagent_session_id = subSid;
        } else {
          fn.arguments = { subagent_type: info.subagentType, description: info.name, subagent_session_id: subSid };
        }
      }
      subagentInteractions.push({
        role: 'subagent',
        agent: info.name,
        subagent_name: info.name,
        subagent_type: info.subagentType,
        subagent_session_id: subSid,
        content: firstText(event.attributes?.['tool.result'], event.attributes?.['output.value']) || '',
        timestamp: toIso(toolStartMs),
        timeInfo: { created: toIso(toolStartMs), completed: toIso(toolEndMs) },
      });
    }

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
  // 子 Agent 交互追加到序列末尾（随后统一按时间戳排序，会落到对应父 task 之后）。
  for (const sub of subagentInteractions) interactions.push(sub);

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

  // WorkBuddy 的 trace 文件是「一次 workflow 完整写完才落盘」，采集到即代表该轮已结束。
  // 设 trace_completed_at / trace_status，界面「执行状态」才会从「执行中」变为「已完成」。
  const lastEnd = Math.max(rootStarted, ...ordered.map((event) => eventEndMs(event)));

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
    // ExecutionRecord.latency 全链路统一为毫秒（详情页用 formatDurationMs(latency) 渲染，
    // 与链路树根节点时长同源同单位）；此前误 /1000 会让头部"耗时"比根节点小 1000 倍。
    latency: latencyMs,
    final_result: finalResult,
    timestamp: new Date(rootStarted),
    trace_started_at: new Date(rootStarted),
    trace_completed_at: new Date(lastEnd),
    trace_status: 'success',
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
