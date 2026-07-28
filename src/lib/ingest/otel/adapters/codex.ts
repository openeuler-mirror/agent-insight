import type { ExecutionRecord, InvokedSkill } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

type AnyObj = Record<string, unknown>;

function attrs(event: OtelTraceEvent): AnyObj {
  return event.attributes || {};
}

function semanticKind(event: OtelTraceEvent): string {
  return String(attrs(event)['agent.insight.kind'] || event.kind || 'span').toLowerCase();
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

function eventInput(event: OtelTraceEvent): string | undefined {
  return content(attrs(event)['input.value']);
}

function eventOutput(event: OtelTraceEvent): string | undefined {
  return content(attrs(event)['output.value'] ?? attrs(event)['tool.result']);
}

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString();
}

function eventModel(event: OtelTraceEvent): string | undefined {
  return content(event.model || attrs(event)['llm.model_name'] || attrs(event)['gen_ai.request.model']);
}

function eventUsage(event: OtelTraceEvent) {
  return {
    input: event.usage.input_tokens || 0,
    output: event.usage.output_tokens || 0,
    reasoning: event.usage.reasoning_tokens || 0,
    total: event.usage.total_tokens || 0,
    cache: {
      read: Number(attrs(event)['codex.usage.cache_read']) || 0,
      write: 0,
    },
    input_tokens: event.usage.input_tokens || 0,
    output_tokens: event.usage.output_tokens || 0,
    reasoning_tokens: event.usage.reasoning_tokens || 0,
  };
}

function agentName(event: OtelTraceEvent): string {
  return content(attrs(event)['codex.agent.name']) ||
    String(event.name || '').replace(/^agent\./, '') ||
    'codex';
}

function toolName(event: OtelTraceEvent): string {
  return content(attrs(event)['tool.name']) ||
    String(event.name || '').replace(/^tool\./, '') ||
    'tool';
}

function ownerFor(
  event: OtelTraceEvent,
  bySpanId: Map<string, OtelTraceEvent>,
): { event?: OtelTraceEvent; name: string; sessionId?: string } {
  let parentId = event.parentSpanId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = bySpanId.get(parentId);
    if (!parent) break;
    if (semanticKind(parent) === 'subagent') {
      return { event: parent, name: agentName(parent), sessionId: parent.spanId };
    }
    parentId = parent.parentSpanId;
  }
  return { name: 'codex' };
}

function ownerFields(owner: ReturnType<typeof ownerFor>): AnyObj {
  if (!owner.sessionId) return { role: 'assistant', agent: 'codex' };
  return {
    role: 'subagent',
    agent: owner.name,
    subagent_name: owner.name,
    subagent_session_id: owner.sessionId,
  };
}

function cloudMetadata(event: OtelTraceEvent): AnyObj | undefined {
  const agentId = content(attrs(event)['codex.cloud.agent_id']);
  const taskId = content(attrs(event)['codex.cloud.task_id']);
  if (!agentId && !taskId) return undefined;
  return {
    ...(agentId ? { agent_id: agentId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    source: content(attrs(event)['codex.cloud.id_source']) || 'otel',
  };
}

function interactionBase(event: OtelTraceEvent, owner: ReturnType<typeof ownerFor>): AnyObj {
  const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completedAt = eventEndMs(event) || startedAt;
  return {
    ...ownerFields(owner),
    timestamp: toIso(startedAt),
    timeInfo: {
      created: toIso(startedAt),
      completed: toIso(completedAt),
    },
    traceId: event.traceId,
    spanId: event.spanId,
    parentSpanId: event.parentSpanId,
    name: event.name,
    source: attrs(event)['codex.tool.source'],
    turn_id: attrs(event)['codex.turn.id'],
    ttft_ms: attrs(event)['codex.ttft_ms'],
    cloud: cloudMetadata(event),
  };
}

function toolCall(event: OtelTraceEvent): AnyObj {
  const eventAttrs = attrs(event);
  const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completedAt = eventEndMs(event) || startedAt;
  const outcome = String(eventAttrs['tool.outcome'] || '').toLowerCase();
  const output = eventOutput(event);
  return {
    id: event.spanId,
    type: 'function',
    state: outcome === 'error' || outcome === 'failed' ? 'error' : 'success',
    function: {
      name: toolName(event),
      arguments: content(eventAttrs['tool.arguments']) || '{}',
    },
    output,
    result: output,
    timing: {
      started_at: toIso(startedAt),
      completed_at: toIso(completedAt),
    },
    metadata: {
      source: eventAttrs['codex.tool.source'],
      call_id: eventAttrs['codex.call.id'],
      exit_code: eventAttrs['codex.tool.exit_code'],
      cloud: cloudMetadata(event),
    },
  };
}

function numericSkillVersion(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function keepLatestCodexSpanSnapshots(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const latest = new Map<string, OtelTraceEvent>();
  const withoutSpan: OtelTraceEvent[] = [];
  for (const event of events) {
    if (!event.spanId) {
      withoutSpan.push(event);
      continue;
    }
    const existing = latest.get(event.spanId);
    if (!existing || eventEndMs(event) >= eventEndMs(existing)) latest.set(event.spanId, event);
  }
  return [...latest.values(), ...withoutSpan]
    .sort((left, right) =>
      (left.startTimeMs || 0) - (right.startTimeMs || 0) ||
      String(left.spanId).localeCompare(String(right.spanId)));
}

export function aggregateCodexTraceEvents(
  sessionId: string,
  events: OtelTraceEvent[],
): ExecutionRecord | null {
  const ordered = events
    .filter((event) => event.sessionId === sessionId)
    .sort((left, right) =>
      (left.startTimeMs || 0) - (right.startTimeMs || 0) ||
      String(left.spanId).localeCompare(String(right.spanId)));
  if (ordered.length === 0) return null;

  const bySpanId = new Map(
    ordered.filter((event) => event.spanId).map((event) => [event.spanId!, event]),
  );
  const interactions: AnyObj[] = [];
  const invokedSkills: InvokedSkill[] = [];
  const skillNames = new Set<string>();
  const llmEvents: OtelTraceEvent[] = [];
  const toolEvents: OtelTraceEvent[] = [];
  const rootEvents: OtelTraceEvent[] = [];
  const subagentEvents: OtelTraceEvent[] = [];
  let toolErrors = 0;

  for (const event of ordered) {
    const kind = semanticKind(event);
    const owner = ownerFor(event, bySpanId);
    if (kind === 'agent') {
      rootEvents.push(event);
      const input = eventInput(event);
      if (input) {
        interactions.push({
          role: 'user',
          agent: 'codex',
          content: input,
          timestamp: toIso(event.startTimeMs),
          timeInfo: {
            created: toIso(event.startTimeMs),
            completed: toIso(event.startTimeMs),
          },
          traceId: event.traceId,
          spanId: `${event.spanId}:input`,
          parentSpanId: event.spanId,
          turn_id: attrs(event)['codex.turn.id'],
        });
      }
      continue;
    }

    if (kind === 'subagent') {
      subagentEvents.push(event);
      const subagent = agentName(event);
      const parentOwner = ownerFor(
        event.parentSpanId ? bySpanId.get(event.parentSpanId) || event : event,
        bySpanId,
      );
      interactions.push({
        ...ownerFields(parentOwner),
        content: '',
        timestamp: toIso(event.startTimeMs),
        timeInfo: {
          created: toIso(event.startTimeMs),
          completed: toIso(event.startTimeMs),
        },
        traceId: event.traceId,
        spanId: `${event.spanId}:spawn`,
        parentSpanId: event.parentSpanId,
        tool_calls: [{
          id: `${event.spanId}:task`,
          type: 'function',
          state: String(attrs(event)['tool.outcome']) === 'error' ? 'error' : 'success',
          function: {
            name: 'task',
            arguments: JSON.stringify({
              subagent_type: subagent,
              session_id: event.spanId,
              description: eventInput(event) || '',
            }),
          },
          output: eventOutput(event),
          result: eventOutput(event),
          timing: {
            started_at: toIso(event.startTimeMs),
            completed_at: toIso(eventEndMs(event)),
          },
        }],
      });
      interactions.push({
        ...interactionBase(event, { event, name: subagent, sessionId: event.spanId }),
        content: eventOutput(event) || '',
        model: eventModel(event),
        usage: eventUsage(event),
      });
      continue;
    }

    if (kind === 'skill') {
      const name = content(attrs(event)['skill.name']) ||
        String(event.name || '').replace(/^skill\./, '');
      const version = attrs(event)['skill.version'];
      if (name && !skillNames.has(name)) {
        skillNames.add(name);
        invokedSkills.push({ name, version: numericSkillVersion(version) });
      }
      interactions.push({
        ...interactionBase(event, owner),
        content: eventOutput(event) || '',
        tool_calls: [{
          id: event.spanId,
          type: 'function',
          state: 'success',
          function: {
            name: 'skill',
            arguments: JSON.stringify({
              name,
              version,
              trigger_mode: attrs(event)['skill.trigger_mode'],
            }),
          },
          output: eventOutput(event),
          result: eventOutput(event),
          timing: {
            started_at: toIso(event.startTimeMs),
            completed_at: toIso(eventEndMs(event)),
          },
        }],
      });
      continue;
    }

    if (kind === 'llm') {
      llmEvents.push(event);
      interactions.push({
        ...interactionBase(event, owner),
        content: eventOutput(event) || '',
        model: eventModel(event),
        provider: content(attrs(event)['llm.provider']),
        usage: eventUsage(event),
      });
      continue;
    }

    if (kind === 'tool' || kind === 'mcp') {
      toolEvents.push(event);
      const outcome = String(attrs(event)['tool.outcome'] || '').toLowerCase();
      if (outcome === 'error' || outcome === 'failed') toolErrors += 1;
      interactions.push({
        ...interactionBase(event, owner),
        content: '',
        tool_calls: [toolCall(event)],
        ...(kind === 'mcp' ? {
          mcp: {
            server_name: attrs(event)['mcp.server.name'],
            tool_name: attrs(event)['mcp.tool.name'],
          },
        } : {}),
      });
    }
  }

  const first = ordered[0];
  const startedAt = Math.min(...ordered.map((event) =>
    event.startTimeMs || Date.parse(event.receivedAt) || Date.now()));
  const endedAt = Math.max(...ordered.map(eventEndMs));
  const query = rootEvents.map(eventInput).find(Boolean) ||
    llmEvents.map(eventInput).find(Boolean) ||
    'Codex Session';
  const finalResult = [...rootEvents].reverse().map(eventOutput).find(Boolean) ||
    [...llmEvents].reverse().map(eventOutput).find(Boolean) ||
    '';
  const inputTokens = llmEvents.reduce((sum, event) => sum + (event.usage.input_tokens || 0), 0);
  const outputTokens = llmEvents.reduce((sum, event) => sum + (event.usage.output_tokens || 0), 0);
  const reasoningTokens = llmEvents.reduce(
    (sum, event) => sum + (event.usage.reasoning_tokens || 0),
    0,
  );
  const cacheReadInputTokens = llmEvents.reduce(
    (sum, event) => sum + (Number(attrs(event)['codex.usage.cache_read']) || 0),
    0,
  );
  const tokens = llmEvents.reduce((sum, event) => sum + (
    event.usage.total_tokens ||
    event.usage.input_tokens +
    event.usage.output_tokens
  ), 0);
  const maxSingleCallTokens = Math.max(
    0,
    ...llmEvents.map((event) => (
      event.usage.total_tokens ||
      event.usage.input_tokens +
      event.usage.output_tokens
    )),
  );
  const model = llmEvents.map(eventModel).find(Boolean) ||
    rootEvents.map(eventModel).find(Boolean) ||
    'unknown';

  return {
    task_id: sessionId,
    query,
    framework: 'codex',
    model,
    tokens,
    latency: Math.max(0, endedAt - startedAt),
    final_result: finalResult,
    timestamp: new Date(startedAt),
    trace_completed_at: new Date(endedAt),
    label: 'codex',
    user: first.user || 'anonymous',
    interactions,
    invokedSkills,
    invoked_skills: invokedSkills,
    skills: invokedSkills.map((skill) => skill.name),
    agent: 'codex',
    agentName: 'codex',
    agents: [...new Set(['codex', ...subagentEvents.map(agentName)])],
    llm_call_count: llmEvents.length,
    tool_call_count: toolEvents.length,
    tool_call_error_count: toolErrors,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens || undefined,
    cache_read_input_tokens: cacheReadInputTokens || undefined,
    max_single_call_tokens: maxSingleCallTokens || undefined,
  };
}

export const codexOtelTraceAdapter: OtelTraceAdapter = {
  id: 'codex',
  matches: (events) => events.some((event) => (
    event.serviceName === 'codex' ||
    event.serviceName === 'codex-cli' ||
    attrs(event)['agent.insight.framework'] === 'codex'
  )),
  preprocessEvents: keepLatestCodexSpanSnapshots,
  aggregate: aggregateCodexTraceEvents,
};
