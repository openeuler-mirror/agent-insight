import type { ExecutionRecord } from '@/lib/storage/data-service';
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

function buildAssistantInteraction(event: OtelTraceEvent): any {
  const attrs = event.attributes || {};
  const prompt = attrs['gen_ai.prompt'] || attrs['db.statement'];
  const completion = attrs['gen_ai.completion'] || attrs['db.result'];
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = created + Math.max(0, event.latencyMs || 0);
  const interaction: any = {
    role: 'assistant',
    content: completion || '',
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    traceId: event.traceId,
    name: event.name,
    model: event.model,
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
      arguments: attrs['tool.arguments'] || JSON.stringify(attrs),
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
  const firstEvent = ordered[0];
  const firstModeledEvent = ordered.find((event) => event.model);
  const framework = firstEvent.serviceName || 'unknown-service';
  const totalInputTokens = ordered.reduce((sum, event) => sum + (event.usage?.input_tokens || 0), 0);
  const totalOutputTokens = ordered.reduce((sum, event) => sum + (event.usage?.output_tokens || 0), 0);
  const totalReasoningTokens = ordered.reduce((sum, event) => sum + (event.usage?.reasoning_tokens || 0), 0);
  const totalLatency = ordered.reduce((sum, event) => sum + (event.latencyMs || 0), 0);

  return {
    task_id: sessionId,
    query: firstPromptInteraction?.requestMessages?.[0]?.content || 'OTel Session',
    framework,
    model: firstModeledEvent?.model || 'unknown',
    tokens: totalInputTokens + totalOutputTokens,
    latency: totalLatency,
    final_result: lastInteraction?.content || '',
    timestamp: new Date(firstEvent.startTimeMs || Date.parse(firstEvent.receivedAt) || Date.now()),
    label: framework,
    user: firstEvent.user || 'anonymous',
    interactions,
    agent: framework,
    agentName: framework,
    llm_call_count: ordered.filter((event) => event.kind === 'llm').length,
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
