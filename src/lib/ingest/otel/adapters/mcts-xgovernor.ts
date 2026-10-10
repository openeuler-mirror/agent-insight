import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

type AnyObject = Record<string, unknown>;

function attributes(event: OtelTraceEvent): AnyObject {
  return event.attributes || {};
}

function content(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() ? value : undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inputOf(event: OtelTraceEvent): string | undefined {
  return content(attributes(event)['input.value'] ?? (event as unknown as AnyObject).input);
}

function outputOf(event: OtelTraceEvent): string | undefined {
  return content(attributes(event)['output.value'] ?? attributes(event)['tool.result'] ?? (event as unknown as AnyObject).output);
}

function endMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || Number((event as AnyObject).endTimeMs) - event.startTimeMs || 0);
}

function usage(event: OtelTraceEvent) {
  const source = event.usage as AnyObject;
  const input = Number(source.input_tokens ?? source.input) || 0;
  const output = Number(source.output_tokens ?? source.output) || 0;
  const reasoning = Number(source.reasoning_tokens ?? source.reasoning) || 0;
  return {
    input,
    output,
    reasoning,
    total: Number(source.total_tokens ?? source.total) || input + output + reasoning,
  };
}

function semanticKind(event: OtelTraceEvent): string {
  return String(attributes(event)['agent.insight.kind'] || event.kind || 'span').toLowerCase();
}

function toolName(event: OtelTraceEvent): string {
  return content(attributes(event)['tool.name']) || String(event.name || '').replace(/^tool\./, '') || 'tool';
}

function toolCall(event: OtelTraceEvent): AnyObject {
  const attrs = attributes(event);
  const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completedAt = endMs(event) || startedAt;
  const outcome = String(attrs['tool.outcome'] || '').toLowerCase();
  const result = outputOf(event);
  return {
    id: event.spanId,
    type: 'function',
    state: outcome === 'error' || outcome === 'failed' ? 'error' : 'success',
    function: {
      name: toolName(event),
      arguments: content(attrs['tool.arguments'] ?? inputOf(event)) || '{}',
    },
    output: result,
    result,
    timing: {
      started_at: startedAt,
      completed_at: completedAt,
      source: 'execution',
    },
  };
}

function dedupe(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const bySpan = new Map<string, OtelTraceEvent>();
  const unkeyed: OtelTraceEvent[] = [];
  for (const event of events) {
    if (!event.spanId) {
      unkeyed.push(event);
      continue;
    }
    const current = bySpan.get(event.spanId);
    if (!current || endMs(event) >= endMs(current)) bySpan.set(event.spanId, event);
  }
  return [...bySpan.values(), ...unkeyed].sort((left, right) => left.startTimeMs - right.startTimeMs);
}

function latestConfirmedRole(events: OtelTraceEvent[]): string | undefined {
  return [...events]
    .sort((left, right) => endMs(right) - endMs(left))
    .map(event => content(attributes(event)['mcts.role']))
    .find(role => role !== undefined && role.toLowerCase() !== 'unknown');
}

function roleOf(events: OtelTraceEvent[]): string {
  const agentRole = latestConfirmedRole(events.filter(event => semanticKind(event) === 'agent'));
  return agentRole || latestConfirmedRole(events) || 'unknown';
}

function aggregate(sessionId: string, source: OtelTraceEvent[]): ExecutionRecord | null {
  const events = dedupe(source.filter(event => event.sessionId === sessionId));
  if (!events.length) return null;
  const agentEvents = events.filter(event => semanticKind(event) === 'agent');
  const llmEvents = events.filter(event => semanticKind(event) === 'llm');
  const toolEvents = events.filter(event => semanticKind(event) === 'tool');
  const role = roleOf(events);
  const agentName = `mcts-${role}`;
  const interactions: AnyObject[] = [];
  const llmBySpan = new Map<string, AnyObject>();

  for (const event of llmEvents) {
    const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
    const completedAt = endMs(event) || startedAt;
    const eventUsage = usage(event);
    const outcome = String(attributes(event)['tool.outcome'] || '').toLowerCase();
    const interaction: AnyObject = {
      role: 'assistant',
      agent: agentName,
      content: outputOf(event) || '',
      timestamp: new Date(startedAt).toISOString(),
      timeInfo: { created: new Date(startedAt).toISOString(), completed: new Date(completedAt).toISOString() },
      traceId: event.traceId,
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      name: event.name,
      model: event.model || content(attributes(event)['llm.model_name']),
      usage: {
        input_tokens: eventUsage.input,
        output_tokens: eventUsage.output,
        reasoning_tokens: eventUsage.reasoning || undefined,
        total: eventUsage.total,
      },
      reasoning: content(attributes(event)['mcts.reasoning']),
      status: outcome === 'error' || outcome === 'failed' ? 'error' : 'success',
    };
    const prompt = inputOf(event);
    if (prompt) interaction.requestMessages = [{ role: 'user', content: prompt }];
    interactions.push(interaction);
    if (event.spanId) llmBySpan.set(event.spanId, interaction);
  }

  for (const event of toolEvents) {
    const call = toolCall(event);
    const parent = event.parentSpanId ? llmBySpan.get(event.parentSpanId) : undefined;
    if (parent) {
      parent.tool_calls = [...(Array.isArray(parent.tool_calls) ? parent.tool_calls : []), call];
      continue;
    }
    const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
    interactions.push({
      role: 'assistant',
      agent: agentName,
      content: '',
      timestamp: new Date(startedAt).toISOString(),
      trace_synthetic: attributes(event)['mcts.synthetic'] === true
        || attributes(event)['mcts.synthetic'] === 'true'
        || attributes(event)['mcts.summary.unbound'] === true
        || attributes(event)['mcts.summary.unbound'] === 'true',
      tool_calls: [call],
    });
  }
  interactions.sort((left, right) => Date.parse(String(left.timestamp || '')) - Date.parse(String(right.timestamp || '')));

  const first = events[0];
  const captureAttributes = attributes(agentEvents.at(-1) || first);
  const firstPrompt = llmEvents.map(inputOf).find(Boolean);
  const finalOutput = [...llmEvents].reverse().map(outputOf).find(Boolean) || '';
  const countedUsage = llmEvents.map(usage);
  const terminal = [...agentEvents].reverse().find(event => {
    const value = attributes(event)['agent.insight.trace.completed'];
    return value === true || value === 'true';
  });
  const startedAt = Math.min(...events.map(event => event.startTimeMs || Date.parse(event.receivedAt) || Date.now()));
  const completedAt = terminal ? endMs(terminal) : undefined;
  const terminalFailed = terminal && ['error', 'failed'].includes(String(attributes(terminal)['tool.outcome'] || '').toLowerCase());

  return {
    task_id: sessionId,
    query: firstPrompt || (role === 'coordinator' ? 'MCTS coordinator run' : `MCTS ${role} runtime`),
    framework: 'mcts-xgovernor',
    model: llmEvents.find(event => event.model)?.model || content(attributes(llmEvents[0] || first)['llm.model_name']) || 'unknown',
    tokens: countedUsage.reduce((sum, item) => sum + item.total, 0),
    input_tokens: countedUsage.reduce((sum, item) => sum + item.input, 0),
    output_tokens: countedUsage.reduce((sum, item) => sum + item.output, 0),
    reasoning_tokens: countedUsage.reduce((sum, item) => sum + item.reasoning, 0) || undefined,
    latency: completedAt ? Math.max(0, completedAt - startedAt) : Math.max(0, ...events.map(event => event.latencyMs || 0)),
    timestamp: new Date(startedAt),
    trace_started_at: new Date(startedAt),
    trace_completed_at: completedAt ? new Date(completedAt) : undefined,
    failures: terminalFailed ? [{
      failure_type: 'agent-process-exit',
      description: 'MCTS process failed or was interrupted',
      context: outputOf(terminal) || '',
      recovery: '',
    }] : [],
    final_result: finalOutput,
    label: agentName,
    user: first.user || 'anonymous',
    interactions,
    agent: agentName,
    agentName,
    agentType: role,
    agents: [agentName],
    llm_call_count: llmEvents.length,
    tool_call_count: toolEvents.length,
    tool_call_error_count: toolEvents.filter(event => ['error', 'failed'].includes(String(attributes(event)['tool.outcome'] || '').toLowerCase())).length,
    session_merge_strategy: 'snapshot-replace',
    complete_session_snapshot: true,
    captureMode: content(captureAttributes['mcts.capture.mode']) || 'reverse-proxy',
    captureFidelity: content(captureAttributes['mcts.capture.fidelity']) || 'xgovernor-sse',
    runtimeRelation: content(captureAttributes['mcts.runtime.relation']) || 'checkpoint-lineage',
    mctsNodeCorrelation: content(captureAttributes['mcts.node.correlation']) || 'unavailable',
    internalBackprop: content(captureAttributes['mcts.internal.backprop']) || 'unavailable',
    memoryPoolEvents: content(captureAttributes['mcts.memory_pool.events']) || 'unavailable',
    projectionTruncated: captureAttributes['mcts.projection.truncated'] === true
      || captureAttributes['mcts.projection.truncated'] === 'true',
  };
}

export const mctsXgovernorOtelTraceAdapter: OtelTraceAdapter = {
  id: 'mcts-xgovernor',
  matches: events => events.some(event => (
    event.framework === 'mcts-xgovernor'
    || attributes(event)['agent.insight.framework'] === 'mcts-xgovernor'
  )),
  aggregate,
};

export { aggregate as aggregateMctsXgovernorTraceEvents };
