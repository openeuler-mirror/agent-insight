import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

function content(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value.trim() ? value : undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function firstContent(...values: any[]): string | undefined {
  for (const value of values) {
    const text = content(value);
    if (text) return text;
  }
  return undefined;
}

function tokenTotal(event: OtelTraceEvent): number {
  return event.usage.total_tokens ||
    event.usage.input_tokens + event.usage.output_tokens + (event.usage.reasoning_tokens || 0);
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

function isAgentContainer(event: OtelTraceEvent): boolean {
  const attrs = event.attributes || {};
  const kind = String(attrs['openinference.span.kind'] || attrs['traceloop.span.kind'] || attrs['span.kind'] || '').toUpperCase();
  return kind === 'AGENT' || String(event.name || '').toLowerCase() === 'agent';
}

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString();
}

function assistantInteraction(event: OtelTraceEvent): any {
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
    timeInfo: { created: toIso(created), completed: toIso(completed) },
    agent: event.serviceName,
  };
  if (prompt) interaction.requestMessages = [{ role: 'user', content: prompt }];
  return interaction;
}

function toolCall(event: OtelTraceEvent): any {
  const attrs = event.attributes || {};
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = created + Math.max(0, event.latencyMs || 0);
  const output = firstContent(attrs['output.value'], attrs['tool.output'], attrs['tool.result']);
  const outcome = String(attrs['tool.status'] || attrs['tool.outcome'] || '').toLowerCase();
  return {
    id: event.spanId,
    type: 'function',
    state: outcome === 'error' || outcome === 'failed' ? 'error' : 'success',
    function: {
      name: attrs['tool.name'] || event.name || 'tool',
      arguments: firstContent(attrs['tool.arguments'], attrs['input.value']) || JSON.stringify(attrs),
    },
    output,
    result: output,
    timing: { started_at: toIso(created), completed_at: toIso(completed) },
  };
}

export function aggregateGenericOtelTraceEvents(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null {
  const ordered = events.filter((event) => event.sessionId === sessionId);
  if (!ordered.length) return null;

  const interactions: any[] = [];
  const assistantBySpanId = new Map<string, any>();
  const toolEvents: OtelTraceEvent[] = [];
  for (const event of ordered) {
    if (event.kind === 'llm') {
      const interaction = assistantInteraction(event);
      interactions.push(interaction);
      if (event.spanId) assistantBySpanId.set(event.spanId, interaction);
    } else {
      toolEvents.push(event);
    }
  }

  for (const event of toolEvents) {
    const call = toolCall(event);
    const host = (event.parentSpanId ? assistantBySpanId.get(event.parentSpanId) : undefined) || interactions[interactions.length - 1];
    if (host) {
      host.tool_calls = Array.isArray(host.tool_calls) ? [...host.tool_calls, call] : [call];
    } else {
      interactions.push({
        role: 'assistant',
        content: '',
        agent: event.serviceName,
        timestamp: toIso(event.startTimeMs || Date.parse(event.receivedAt) || Date.now()),
        tool_calls: [call],
      });
    }
  }

  const usageEvents = ordered.filter((event) => tokenTotal(event) > 0);
  const nonContainers = usageEvents.filter((event) => !isAgentContainer(event));
  const countedUsage = ordered.some(isAgentContainer) && nonContainers.length ? nonContainers : usageEvents;
  const latencies = ordered.map((event) => event.latencyMs || 0).filter((value) => value > 0);
  const latency = ordered.some(isAgentContainer)
    ? Math.max(0, ...latencies)
    : latencies.reduce((sum, value) => sum + value, 0);
  const firstPrompt = interactions.find((interaction) => interaction?.requestMessages?.[0]?.content);
  const lastContent = [...interactions].reverse().find((interaction) => interaction?.content);
  const firstEvent = ordered[0];
  const modelEvent = ordered.find((event) => eventModel(event));

  return {
    task_id: sessionId,
    query: firstPrompt?.requestMessages?.[0]?.content || 'OTel Session',
    framework: firstEvent.serviceName || 'unknown-service',
    model: modelEvent ? eventModel(modelEvent) || 'unknown' : 'unknown',
    tokens: countedUsage.reduce((sum, event) => sum + tokenTotal(event), 0),
    latency,
    final_result: lastContent?.content || '',
    timestamp: new Date(firstEvent.startTimeMs || Date.parse(firstEvent.receivedAt) || Date.now()),
    label: firstEvent.serviceName || 'unknown-service',
    user: firstEvent.user || 'anonymous',
    interactions,
    agent: firstEvent.serviceName,
    agentName: firstEvent.serviceName,
    llm_call_count: ordered.filter((event) => event.kind === 'llm' && !isAgentContainer(event)).length,
    tool_call_count: toolEvents.length,
    tool_call_error_count: toolEvents.filter((event) => {
      const outcome = String(event.attributes?.['tool.status'] || event.attributes?.['tool.outcome'] || '').toLowerCase();
      return outcome === 'error' || outcome === 'failed';
    }).length,
    input_tokens: countedUsage.reduce((sum, event) => sum + event.usage.input_tokens, 0),
    output_tokens: countedUsage.reduce((sum, event) => sum + event.usage.output_tokens, 0),
    reasoning_tokens: countedUsage.reduce((sum, event) => sum + (event.usage.reasoning_tokens || 0), 0) || undefined,
  };
}

export const genericOtelTraceAdapter: OtelTraceAdapter = {
  id: 'generic',
  matches: () => true,
  aggregate: aggregateGenericOtelTraceEvents,
};
