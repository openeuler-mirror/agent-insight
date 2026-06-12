import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '@/lib/ingest/claude-otel/types';

type AnyObj = Record<string, any>;

function eventSortValue(event: OtelTraceEvent): number {
  return Number.isFinite(event.startTimeMs) ? event.startTimeMs : 0;
}

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString();
}

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function asContent(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? value : undefined;
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return String(value);
}

function firstContent(...values: any[]): string | undefined {
  for (const value of values) {
    const content = asContent(value);
    if (content) return content;
  }
  return undefined;
}

function eventModel(event: OtelTraceEvent): string | undefined {
  const attrs = event.attributes || {};
  return firstContent(
    event.model,
    attrs['gen_ai.request.model'],
    attrs['llm.request.model'],
    attrs['llm.model_name'],
    attrs['gen_ai.response.model'],
  );
}

function spanKind(event: OtelTraceEvent): string {
  const attrs = event.attributes || {};
  return String(attrs['openinference.span.kind'] || attrs['traceloop.span.kind'] || attrs['span.kind'] || '').toUpperCase();
}

function eventTokenTotal(event: OtelTraceEvent): number {
  const usage = event.usage || {};
  return usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.reasoning_tokens || 0);
}

function isAgentContainer(event: OtelTraceEvent): boolean {
  const attrs = event.attributes || {};
  if (spanKind(event) === 'AGENT') return true;
  if (String(attrs['hermes.session.kind'] || '').toLowerCase() === 'session') return true;
  return String(event.name || '').toLowerCase() === 'agent';
}

function isApiSpan(event: OtelTraceEvent): boolean {
  return String(event.name || '').startsWith('api.');
}

function isLlmContainer(event: OtelTraceEvent): boolean {
  if (event.kind !== 'llm') return false;
  if (isAgentContainer(event) || isApiSpan(event)) return false;
  const attrs = event.attributes || {};
  if (String(event.name || '').startsWith('llm.')) return true;
  return attrs['input.value'] !== undefined || attrs['output.value'] !== undefined;
}

function isToolSpan(event: OtelTraceEvent): boolean {
  return event.kind === 'tool' || spanKind(event) === 'TOOL' || (event.attributes || {})['tool.name'] !== undefined;
}

function toolName(event: OtelTraceEvent): string {
  const attrs = event.attributes || {};
  const raw = attrs['tool.name'] || event.name || 'tool';
  return String(raw).replace(/^tool\./, '') || 'tool';
}

function parseMaybeJson(value: string | undefined): any {
  if (!value) return value;
  const text = value.trim();
  if (!text) return value;
  if (!text.startsWith('{') && !text.startsWith('[')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

function stringifyMessageContent(content: any): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part?.text) return String(part.text);
        if (part?.content) return stringifyMessageContent(part.content);
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    if (content.text) return String(content.text);
    if (content.content) return stringifyMessageContent(content.content);
  }
  return String(content);
}

function latestUserMessageFromJson(value: string | undefined): string | undefined {
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : undefined;
  const messages = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.messages)
      ? parsed.messages
      : undefined;
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (String(msg?.role || '').toLowerCase() !== 'user') continue;
    const text = stringifyMessageContent(msg.content);
    if (text.trim()) return text;
  }
  return undefined;
}

function assistantTextFromJson(value: string | undefined): string | undefined {
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : undefined;
  if (!parsed || typeof parsed !== 'object') return undefined;

  const choices = Array.isArray(parsed.choices) ? parsed.choices : undefined;
  if (choices) {
    const text = choices
      .map((choice: any) => stringifyMessageContent(
        choice?.message?.content ??
        choice?.delta?.content ??
        choice?.text,
      ))
      .filter((part: string) => part.trim())
      .join('\n');
    if (text.trim()) return text;
  }

  const outputText = firstContent(
    parsed.output_text,
    parsed.message?.content,
    parsed.content,
    parsed.text,
  );
  if (outputText) return outputText;

  if (Array.isArray(parsed.output)) {
    const text = parsed.output
      .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [item?.content ?? item])
      .map((part: any) => stringifyMessageContent(part?.text ?? part?.content ?? part))
      .filter((part: string) => part.trim())
      .join('\n');
    if (text.trim()) return text;
  }

  return undefined;
}

function inputText(event: OtelTraceEvent | undefined): string | undefined {
  if (!event) return undefined;
  const raw = firstContent(event.attributes?.['input.value']);
  return latestUserMessageFromJson(raw) || raw;
}

function outputText(event: OtelTraceEvent | undefined): string | undefined {
  if (!event) return undefined;
  const raw = firstContent(event.attributes?.['output.value']);
  if (!raw) return undefined;
  const parsed = parseMaybeJson(raw);
  if (parsed && typeof parsed === 'object') {
    return assistantTextFromJson(raw);
  }
  return raw;
}

function usageForEvents(events: OtelTraceEvent[]) {
  return {
    input_tokens: events.reduce((sum, event) => sum + (event.usage?.input_tokens || 0), 0),
    output_tokens: events.reduce((sum, event) => sum + (event.usage?.output_tokens || 0), 0),
    reasoning_tokens: events.reduce((sum, event) => sum + (event.usage?.reasoning_tokens || 0), 0),
    total: events.reduce((sum, event) => sum + eventTokenTotal(event), 0),
  };
}

function buildToolCall(event: OtelTraceEvent): AnyObj {
  const attrs = event.attributes || {};
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = eventEndMs(event) || created;
  const output = firstContent(attrs['output.value'], attrs['tool.output'], attrs['tool.result']);
  const outcome = String(attrs['hermes.tool.outcome'] || attrs['tool.outcome'] || '').toLowerCase();
  const state = outcome === 'error' || outcome === 'failed' ? 'error' : 'success';
  return {
    id: event.spanId,
    type: 'function',
    state,
    function: {
      name: toolName(event),
      arguments: firstContent(attrs['tool.arguments'], attrs['input.value']) || JSON.stringify(attrs),
    },
    output,
    result: output,
    timing: {
      started_at: toIso(created),
      completed_at: toIso(completed),
    },
  };
}

function buildChildren(events: OtelTraceEvent[]): Map<string, OtelTraceEvent[]> {
  const children = new Map<string, OtelTraceEvent[]>();
  for (const event of events) {
    if (!event.parentSpanId) continue;
    const list = children.get(event.parentSpanId) || [];
    list.push(event);
    children.set(event.parentSpanId, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => eventSortValue(a) - eventSortValue(b));
  }
  return children;
}

function collectDescendants(root: OtelTraceEvent, children: Map<string, OtelTraceEvent[]>): OtelTraceEvent[] {
  if (!root.spanId) return [];
  const out: OtelTraceEvent[] = [];
  const stack = [...(children.get(root.spanId) || [])];
  while (stack.length > 0) {
    const event = stack.shift()!;
    out.push(event);
    if (event.spanId) stack.push(...(children.get(event.spanId) || []));
  }
  return out.sort((a, b) => eventSortValue(a) - eventSortValue(b));
}

function selectUsageEvents(events: OtelTraceEvent[], agent?: OtelTraceEvent): OtelTraceEvent[] {
  if (agent && eventTokenTotal(agent) > 0) return [agent];
  const apiUsage = events.filter((event) => isApiSpan(event) && eventTokenTotal(event) > 0);
  if (apiUsage.length > 0) return apiUsage;
  return events.filter((event) => eventTokenTotal(event) > 0 && !isLlmContainer(event));
}

function makeUserInteraction(args: {
  content: string;
  event: OtelTraceEvent;
  framework: string;
}): AnyObj {
  const created = args.event.startTimeMs || Date.parse(args.event.receivedAt) || Date.now();
  return {
    role: 'user',
    content: args.content,
    timestamp: toIso(created),
    timeInfo: {
      created: toIso(created),
      completed: toIso(created),
    },
    agent: args.framework,
    traceId: args.event.traceId,
    spanId: `${args.event.spanId || 'llm'}:input`,
  };
}

function makeToolInteraction(args: {
  llm: OtelTraceEvent;
  tool: OtelTraceEvent;
  framework: string;
  model?: string;
}): AnyObj {
  const created = args.tool.startTimeMs || Date.parse(args.tool.receivedAt) || Date.now();
  const completed = eventEndMs(args.tool) || created;
  return {
    role: 'assistant',
    content: '',
    timestamp: toIso(created),
    timeInfo: {
      created: toIso(created),
      completed: toIso(completed),
    },
    agent: args.framework,
    traceId: args.llm.traceId,
    spanId: `${args.llm.spanId || 'llm'}:${args.tool.spanId || toolName(args.tool)}`,
    parentSpanId: args.llm.spanId,
    name: `tool.${toolName(args.tool)}`,
    model: args.model,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total: 0,
    },
    tool_calls: [buildToolCall(args.tool)],
  };
}

function makeAssistantInteraction(args: {
  content: string;
  llm: OtelTraceEvent;
  sourceEvent?: OtelTraceEvent;
  framework: string;
  model?: string;
  usageEvents: OtelTraceEvent[];
}): AnyObj {
  const source = args.sourceEvent || args.llm;
  const created = Math.max(
    source.startTimeMs || 0,
    ...args.usageEvents.map((event) => event.startTimeMs || 0),
  ) || Date.parse(source.receivedAt) || Date.now();
  const completed = eventEndMs(source) || created;
  const usage = usageForEvents(args.usageEvents);
  return {
    role: 'assistant',
    content: args.content,
    timestamp: toIso(created),
    timeInfo: {
      created: toIso(created),
      completed: toIso(completed),
    },
    agent: args.framework,
    traceId: source.traceId,
    spanId: `${source.spanId || args.llm.spanId || 'llm'}:output`,
    parentSpanId: source.parentSpanId || args.llm.spanId,
    name: source.name,
    model: args.model,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      reasoning_tokens: usage.reasoning_tokens || undefined,
      total: usage.total,
    },
  };
}

export function aggregateHermesTraceEvents(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null {
  const ordered = events
    .filter((event) => event.sessionId === sessionId)
    .sort((a, b) => eventSortValue(a) - eventSortValue(b));

  if (ordered.length === 0) return null;

  const framework = ordered.find((event) => event.serviceName)?.serviceName || 'hermes';
  const children = buildChildren(ordered);
  const agent = ordered.find(isAgentContainer);
  const llmContainers = ordered.filter(isLlmContainer);
  const contentHosts = llmContainers.length > 0
    ? llmContainers
    : agent
      ? [agent]
      : [];

  const interactions: AnyObj[] = [];
  const models = ordered.map(eventModel).filter(Boolean) as string[];
  const model = models[0] || 'unknown';

  for (const llm of contentHosts) {
    const subtree = collectDescendants(llm, children);
    const subtreeEvents = subtree.length > 0 ? subtree : ordered.filter((event) => event.traceId === llm.traceId && event !== llm);
    const apiEvents = subtreeEvents.filter((event) => isApiSpan(event) && eventTokenTotal(event) > 0);
    const toolEvents = subtreeEvents.filter(isToolSpan);
    const finalApi = [...apiEvents].reverse().find((event) =>
      String(event.attributes?.['llm.response.finish_reason'] || '').toLowerCase() === 'stop' &&
      outputText(event)
    );
    const userInput = inputText(llm) || inputText(agent);
    const assistantOutput = outputText(finalApi) || outputText(llm) || outputText(agent);

    if (userInput) {
      const previousUser = [...interactions].reverse().find((interaction) => interaction.role === 'user');
      if (!previousUser || previousUser.content !== userInput) {
        interactions.push(makeUserInteraction({ content: userInput, event: llm, framework }));
      }
    }

    for (const event of subtreeEvents.filter((event) => isApiSpan(event) || isToolSpan(event))) {
      if (isApiSpan(event)) {
        if (event === finalApi) continue;
        const apiOutput = outputText(event);
        if (apiOutput) {
          interactions.push(makeAssistantInteraction({
            content: apiOutput,
            llm,
            sourceEvent: event,
            framework,
            model: eventModel(event) || model,
            usageEvents: [event],
          }));
        }
        continue;
      }

      interactions.push(makeToolInteraction({ llm, tool: event, framework, model }));
    }

    if (assistantOutput) {
      interactions.push(makeAssistantInteraction({
        content: assistantOutput,
        llm,
        sourceEvent: finalApi,
        framework,
        model,
        usageEvents: finalApi ? [finalApi] : apiEvents,
      }));
    }
  }

  if (interactions.length === 0) {
    return null;
  }

  interactions.sort((a, b) => {
    const at = Date.parse(a.timestamp || '') || 0;
    const bt = Date.parse(b.timestamp || '') || 0;
    return at - bt;
  });

  const usageEvents = selectUsageEvents(ordered, agent);
  const totalUsage = usageForEvents(usageEvents);
  const firstEvent = agent || ordered[0];
  const lastAssistant = [...interactions].reverse().find((interaction) => interaction.role === 'assistant' && String(interaction.content || '').trim());
  const firstUser = interactions.find((interaction) => interaction.role === 'user' && String(interaction.content || '').trim());
  const latency = agent?.latencyMs || Math.max(...ordered.map((event) => event.latencyMs || 0), 0);
  const llmCallCount = ordered.filter((event) => isApiSpan(event) && eventTokenTotal(event) > 0).length ||
    contentHosts.length;

  return {
    task_id: sessionId,
    query: firstUser?.content || 'Hermes Session',
    framework,
    model,
    tokens: totalUsage.total,
    latency,
    final_result: lastAssistant?.content || '',
    timestamp: new Date(firstEvent.startTimeMs || Date.parse(firstEvent.receivedAt) || Date.now()),
    label: framework,
    user: firstEvent.user || 'anonymous',
    interactions,
    agent: framework,
    agentName: framework,
    llm_call_count: llmCallCount,
    tool_call_count: ordered.filter(isToolSpan).length,
    input_tokens: totalUsage.input_tokens,
    output_tokens: totalUsage.output_tokens,
    reasoning_tokens: totalUsage.reasoning_tokens || undefined,
  };
}
