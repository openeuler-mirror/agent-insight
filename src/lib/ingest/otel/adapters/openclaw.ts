import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

function tokenTotal(event: OtelTraceEvent): number {
  return event.usage.total_tokens ||
    event.usage.input_tokens + event.usage.output_tokens + (event.usage.reasoning_tokens || 0);
}

function eventModel(event: OtelTraceEvent): string | undefined {
  const attrs = event.attributes || {};
  return event.model || attrs['gen_ai.request.model'] || attrs['llm.request.model'] || attrs['llm.model_name'];
}

function assistantInteraction(event: OtelTraceEvent): any {
  const attrs = event.attributes || {};
  const prompt = attrs['gen_ai.prompt'] || attrs['input.value'] || '';
  const completion = attrs['gen_ai.completion'] || attrs['output.value'] || '';
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = created + Math.max(0, event.latencyMs || 0);
  return {
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
    timestamp: new Date(created).toISOString(),
    timeInfo: {
      created: new Date(created).toISOString(),
      completed: new Date(completed).toISOString(),
    },
    agent: event.serviceName,
    requestMessages: prompt ? [{ role: 'user', content: prompt }] : undefined,
  };
}

function cleanQuery(raw: string | undefined): string {
  if (!raw) return '';
  // Filter out file paths and internal telemetry noise
  if (raw.includes('\\') || raw.includes('/')) {
    const isLikelyPath = /^[A-Z]?:?[/\\]/.test(raw) || raw.includes('node_modules') || raw.includes('.agent-insight');
    if (isLikelyPath) return '';
  }
  return raw.trim();
}

export function aggregateOpenClawOtelTraceEvents(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null {
  const ordered = events.filter((event) => event.sessionId === sessionId);
  if (!ordered.length) return null;

  // Filter out empty telemetry heartbeats
  const meaningfulEvents = ordered.filter((event) => {
    const hasCompletion = event.attributes?.['gen_ai.completion'];
    const hasPrompt = event.attributes?.['gen_ai.prompt'];
    const hasTokens = tokenTotal(event) > 0;
    const hasLatency = (event.latencyMs || 0) > 0;
    const isLLMCall = event.kind === 'llm';
    return isLLMCall && (hasTokens || hasLatency || (hasCompletion && hasPrompt));
  });

  if (!meaningfulEvents.length) return null;

  const interactions = meaningfulEvents.map(assistantInteraction);
  const firstPrompt = interactions.find((i) => i?.requestMessages?.[0]?.content);
  const lastContent = [...interactions].reverse().find((i) => i?.content);
  const firstEvent = meaningfulEvents[0];
  const modelEvent = meaningfulEvents.find((event) => eventModel(event));

  const query = cleanQuery(firstPrompt?.requestMessages?.[0]?.content) || 'OpenClaw Task';

  const latencies = meaningfulEvents.map((event) => event.latencyMs || 0).filter((v) => v > 0);
  const latency = latencies.length ? latencies.reduce((sum, v) => sum + v, 0) : 0;
  const tokens = meaningfulEvents.reduce((sum, event) => sum + tokenTotal(event), 0);

  return {
    task_id: sessionId,
    query,
    framework: 'openclaw',
    model: modelEvent ? eventModel(modelEvent) || 'unknown' : 'unknown',
    tokens,
    latency,
    final_result: lastContent?.content || '',
    timestamp: new Date(firstEvent.startTimeMs || Date.parse(firstEvent.receivedAt) || Date.now()),
    label: 'openclaw',
    user: firstEvent.user || 'anonymous',
    interactions,
    agent: 'openclaw',
    agentName: 'openclaw',
    llm_call_count: meaningfulEvents.filter((event) => event.kind === 'llm').length,
    tool_call_count: 0,
    tool_call_error_count: 0,
    input_tokens: meaningfulEvents.reduce((sum, event) => sum + event.usage.input_tokens, 0),
    output_tokens: meaningfulEvents.reduce((sum, event) => sum + event.usage.output_tokens, 0),
    reasoning_tokens: meaningfulEvents.reduce((sum, event) => sum + (event.usage.reasoning_tokens || 0), 0) || undefined,
  };
}

export const openclawOtelTraceAdapter: OtelTraceAdapter = {
  id: 'openclaw',
  matches: (events) => events.some((event) =>
    event.serviceName?.toLowerCase() === 'openclaw' ||
    event.serviceName?.toLowerCase() === 'openclaw-agent'
  ),
  aggregate: aggregateOpenClawOtelTraceEvents,
};
