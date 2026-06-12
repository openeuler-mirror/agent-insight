import type { ExecutionRecord } from '@/lib/storage/data-service';
import { aggregateHermesTraceEvents } from '@/lib/ingest/otel/adapters/hermes';
import { readOtelTraceEventsForSession } from './spool';
import type { OtelTraceAggregationResult, OtelTraceEvent } from './types';

function eventSortValue(event: OtelTraceEvent): number {
  return Number.isFinite(event.startTimeMs) ? event.startTimeMs : 0;
}

function eventDedupeKey(event: OtelTraceEvent): string {
  return event.spanId ||
    [
      event.sessionId,
      event.traceId || '',
      event.name || '',
      event.kind,
      event.startTimeMs || '',
    ].join('|');
}

function dedupeTraceEvents(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const seen = new Set<string>();
  const out: OtelTraceEvent[] = [];
  for (const event of events) {
    const key = eventDedupeKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString();
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

function eventTokenTotal(event: OtelTraceEvent): number {
  const usage = event.usage || {};
  return usage.total_tokens || (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.reasoning_tokens || 0);
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

function isAgentContainerEvent(event: OtelTraceEvent): boolean {
  const attrs = event.attributes || {};
  const spanKind = String(attrs['openinference.span.kind'] || attrs['traceloop.span.kind'] || attrs['span.kind'] || '').toUpperCase();
  if (spanKind === 'AGENT') return true;
  if (String(attrs['hermes.session.kind'] || '').toLowerCase() === 'session') return true;
  return String(event.name || '').toLowerCase() === 'agent';
}

function selectUsageEvents(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const usageEvents = events.filter((event) => eventTokenTotal(event) > 0);
  const hasAgentContainer = events.some(isAgentContainerEvent);
  if (!hasAgentContainer) return usageEvents;
  const nonContainerEvents = usageEvents.filter((event) => !isAgentContainerEvent(event));
  return nonContainerEvents.length > 0 ? nonContainerEvents : usageEvents;
}

function aggregateLatency(events: OtelTraceEvent[]): number {
  const latencies = events.map((event) => event.latencyMs || 0).filter((latency) => latency > 0);
  if (latencies.length === 0) return 0;
  if (events.some(isAgentContainerEvent)) return Math.max(...latencies);
  return latencies.reduce((sum, latency) => sum + latency, 0);
}

function buildAssistantInteraction(event: OtelTraceEvent): any {
  const attrs = event.attributes || {};
  const prompt = firstContent(attrs['gen_ai.prompt'], attrs['input.value'], attrs['db.statement']);
  const completion = firstContent(attrs['gen_ai.completion'], attrs['output.value'], attrs['db.result']);
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = created + Math.max(0, event.latencyMs || 0);
  const interaction: any = {
    role: 'assistant',
    content: completion || '',
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    traceId: event.traceId,
    name: event.name,
    model: eventModel(event),
    usage: {
      input_tokens: event.usage.input_tokens,
      output_tokens: event.usage.output_tokens,
      reasoning_tokens: event.usage.reasoning_tokens || undefined,
      total: event.usage.total_tokens,
    },
    timestamp: toIso(created),
    timeInfo: {
      created: toIso(created),
      completed: toIso(completed),
    },
    agent: event.serviceName,
  };

  if (prompt) interaction.requestMessages = [{ role: 'user', content: prompt }];

  return interaction;
}

function buildToolCall(event: OtelTraceEvent): any {
  const attrs = event.attributes || {};
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = created + Math.max(0, event.latencyMs || 0);
  return {
    id: event.spanId,
    type: 'function',
    state: 'success',
    function: {
      name: attrs['tool.name'] || event.name || 'tool',
      arguments: firstContent(attrs['tool.arguments'], attrs['input.value']) || JSON.stringify(attrs),
    },
    timing: {
      started_at: toIso(created),
      completed_at: toIso(completed),
    },
  };
}

export function aggregateOtelTraceEvents(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null {
  const ordered = dedupeTraceEvents(events)
    .filter((event) => event.sessionId === sessionId)
    .sort((a, b) => eventSortValue(a) - eventSortValue(b));

  if (ordered.length === 0) return null;

  if (ordered.some((event) => event.serviceName === 'hermes' || event.attributes?.['hermes.session_id'])) {
    return aggregateHermesTraceEvents(sessionId, ordered);
  }

  const interactions: any[] = [];
  const assistantBySpanId = new Map<string, any>();
  const toolEvents: OtelTraceEvent[] = [];
  for (const event of ordered) {
    if (event.kind === 'llm') {
      const interaction = buildAssistantInteraction(event);
      interactions.push(interaction);
      if (event.spanId) assistantBySpanId.set(event.spanId, interaction);
      continue;
    }

    toolEvents.push(event);
  }

  for (const event of toolEvents) {
    const toolCall = buildToolCall(event);
    const parent = event.parentSpanId ? assistantBySpanId.get(event.parentSpanId) : undefined;
    const host = parent || interactions[interactions.length - 1];
    if (host) {
      host.tool_calls = Array.isArray(host.tool_calls) ? [...host.tool_calls, toolCall] : [toolCall];
    } else {
      interactions.push({
        role: 'assistant',
        content: '',
        agent: event.serviceName,
        timestamp: toIso(event.startTimeMs || Date.parse(event.receivedAt) || Date.now()),
        tool_calls: [toolCall],
      });
    }
  }
  const firstPromptInteraction = interactions.find((interaction) => interaction?.requestMessages?.[0]?.content);
  const lastInteraction = interactions[interactions.length - 1];
  const lastContentInteraction = [...interactions].reverse().find((interaction) => interaction?.content);
  const firstEvent = ordered[0];
  const firstModeledEvent = ordered.find((event) => eventModel(event));
  const framework = firstEvent.serviceName || 'unknown-service';
  const usageEvents = selectUsageEvents(ordered);
  const totalInputTokens = usageEvents.reduce((sum, event) => sum + (event.usage?.input_tokens || 0), 0);
  const totalOutputTokens = usageEvents.reduce((sum, event) => sum + (event.usage?.output_tokens || 0), 0);
  const totalReasoningTokens = usageEvents.reduce((sum, event) => sum + (event.usage?.reasoning_tokens || 0), 0);
  const totalTokens = usageEvents.reduce((sum, event) => sum + eventTokenTotal(event), 0);
  const totalLatency = aggregateLatency(ordered);
  const llmUsageEvents = usageEvents.filter((event) => event.kind === 'llm');
  const hasAgentContainer = ordered.some(isAgentContainerEvent);
  const llmCountEvents = hasAgentContainer && llmUsageEvents.length > 0
    ? llmUsageEvents
    : ordered.filter((event) => event.kind === 'llm' && (!hasAgentContainer || !isAgentContainerEvent(event)));

  return {
    task_id: sessionId,
    query: firstPromptInteraction?.requestMessages?.[0]?.content || 'OTel Session',
    framework,
    model: firstModeledEvent ? eventModel(firstModeledEvent) || 'unknown' : 'unknown',
    tokens: totalTokens,
    latency: totalLatency,
    final_result: lastContentInteraction?.content || lastInteraction?.content || '',
    timestamp: new Date(firstEvent.startTimeMs || Date.parse(firstEvent.receivedAt) || Date.now()),
    label: framework,
    user: firstEvent.user || 'anonymous',
    interactions,
    agent: framework,
    agentName: framework,
    llm_call_count: llmCountEvents.length,
    tool_call_count: ordered.filter((event) => event.kind === 'tool').length,
    input_tokens: totalInputTokens,
    output_tokens: totalOutputTokens,
    reasoning_tokens: totalReasoningTokens || undefined,
  };
}

export function aggregateOtelTraceSession(
  sessionId: string,
  spoolDir?: string,
): OtelTraceAggregationResult {
  const events = readOtelTraceEventsForSession(sessionId, spoolDir);
  return {
    sessionId,
    eventCount: events.length,
    record: aggregateOtelTraceEvents(sessionId, events),
  };
}
