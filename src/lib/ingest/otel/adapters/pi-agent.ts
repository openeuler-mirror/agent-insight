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
  return content(
    event.model ||
    attrs(event)['llm.model_name'] ||
    attrs(event)['gen_ai.request.model'],
  );
}

function eventUsage(event: OtelTraceEvent) {
  const cacheRead = Number(attrs(event)['pi.usage.cache_read']) || 0;
  const cacheWrite = Number(attrs(event)['pi.usage.cache_write']) || 0;
  return {
    input: event.usage.input_tokens || 0,
    output: event.usage.output_tokens || 0,
    reasoning: event.usage.reasoning_tokens || 0,
    total: event.usage.total_tokens || 0,
    cache: { read: cacheRead, write: cacheWrite },
    input_tokens: event.usage.input_tokens || 0,
    output_tokens: event.usage.output_tokens || 0,
    reasoning_tokens: event.usage.reasoning_tokens || 0,
  };
}

function agentName(event: OtelTraceEvent): string {
  return content(attrs(event)['pi.subagent.name']) ||
    String(event.name || '').replace(/^agent\./, '') ||
    'pi-agent';
}

function toolName(event: OtelTraceEvent): string {
  return content(attrs(event)['tool.name']) ||
    String(event.name || '').replace(/^tool\./, '') ||
    'tool';
}

function toolCall(event: OtelTraceEvent, overrides: AnyObj = {}): AnyObj {
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
    ...overrides,
  };
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
  return { name: 'pi-agent' };
}

function ownerFields(owner: ReturnType<typeof ownerFor>): AnyObj {
  if (!owner.sessionId) return { role: 'assistant', agent: 'pi-agent' };
  return {
    role: 'subagent',
    // Pi's subagent extension starts a separate Pi process from this profile.
    // Its profile is therefore the actual AGENT identity; the framework remains
    // available independently as `pi-agent` on the execution record.
    agent: owner.name,
    subagent_name: owner.name,
    subagent_session_id: owner.sessionId,
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
  };
}

function numericSkillVersion(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  // semver 如 "1.0.0"（skill frontmatter 常用格式）解析为整数主版本号
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value).trim());
  return semver ? Number(semver[1]) : null;
}

function dedupeBySpan(events: OtelTraceEvent[]): OtelTraceEvent[] {
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
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0) || String(a.spanId).localeCompare(String(b.spanId)));
}

export function aggregatePiAgentTraceEvents(
  sessionId: string,
  events: OtelTraceEvent[],
): ExecutionRecord | null {
  const ordered = dedupeBySpan(events.filter((event) => event.sessionId === sessionId));
  if (ordered.length === 0) return null;

  const bySpanId = new Map(
    ordered.filter((event) => event.spanId).map((event) => [event.spanId!, event]),
  );
  const interactions: AnyObj[] = [];
  const invokedSkills: InvokedSkill[] = [];
  const skillNames = new Set<string>();
  const llmEvents: OtelTraceEvent[] = [];
  const toolEvents: OtelTraceEvent[] = [];
  const agentEvents: OtelTraceEvent[] = [];
  const subagentsWithVisibleLeafLlm = new Set<string>();
  let toolErrors = 0;

  for (const event of ordered) {
    if (semanticKind(event) !== 'llm' || !eventOutput(event)) continue;
    const owner = ownerFor(event, bySpanId);
    if (owner.event?.spanId && semanticKind(owner.event) === 'subagent') {
      subagentsWithVisibleLeafLlm.add(owner.event.spanId);
    }
  }

  for (const event of ordered) {
    const kind = semanticKind(event);
    const owner = ownerFor(event, bySpanId);

    if (kind === 'agent') {
      agentEvents.push(event);
      const input = eventInput(event);
      if (input) {
        interactions.push({
          role: 'user',
          agent: 'pi-agent',
          content: input,
          timestamp: toIso(event.startTimeMs),
          timeInfo: {
            created: toIso(event.startTimeMs),
            completed: toIso(event.startTimeMs),
          },
          traceId: event.traceId,
          spanId: `${event.spanId}:input`,
          parentSpanId: event.spanId,
        });
      }
      continue;
    }

    if (kind === 'subagent') {
      const subagent = agentName(event);
      const hasVisibleLeafLlm = Boolean(event.spanId && subagentsWithVisibleLeafLlm.has(event.spanId));
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
          state: String(attrs(event)['pi.subagent.exit_code']) === '0' ? 'success' : 'error',
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
        ...interactionBase(event, {
          event,
          name: subagent,
          sessionId: event.spanId,
        }),
        // The subagent result is a tree anchor and fallback result. When its
        // nested LLM messages already contain visible output, rendering this
        // summary as another LLM duplicates the same final answer and usage.
        content: hasVisibleLeafLlm ? '' : eventOutput(event) || '',
        ...(hasVisibleLeafLlm ? {} : {
          model: eventModel(event),
          usage: eventUsage(event),
        }),
      });
      continue;
    }

    if (kind === 'skill') {
      const name = content(attrs(event)['skill.name']) || String(event.name || '').replace(/^skill\./, '');
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
        stop_reason: content(attrs(event)['pi.stop_reason']),
        requestMessages: eventInput(event)
          ? [{ role: 'user', content: eventInput(event) }]
          : undefined,
      });
      continue;
    }

    if (kind === 'tool' || kind === 'mcp') {
      toolEvents.push(event);
      const outcome = String(attrs(event)['tool.outcome'] || '').toLowerCase();
      if (outcome === 'error' || outcome === 'failed') toolErrors += 1;
      if (toolName(event).toLowerCase() === 'subagent') continue;
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
  // latency 用根 agent 事件（真实一次任务的跨度），避免整个 session 多个 agent
  // 事件首尾被算成一次任务（sessionId 覆盖时会产生跨任务的天级 latency）。
  // 根 agent = 按时间最早的 agent 事件（同 session 多个任务时各 agent 都是根，
  // 取第一个代表本次聚合的任务）。
  const sortedAgents = [...agentEvents].sort(
    (a, b) => (a.startTimeMs || Date.parse(a.receivedAt) || 0) - (b.startTimeMs || Date.parse(b.receivedAt) || 0),
  );
  const rootAgentEvents = sortedAgents.slice(0, 1);
  const startCandidates = rootAgentEvents.length
    ? rootAgentEvents.map((event) => event.startTimeMs || Date.parse(event.receivedAt) || Date.now())
    : ordered.map((event) => event.startTimeMs || Date.parse(event.receivedAt) || Date.now());
  const endCandidates = rootAgentEvents.length
    ? rootAgentEvents.map(eventEndMs)
    : ordered.map(eventEndMs);
  const startedAt = Math.min(...startCandidates);
  const endedAt = Math.max(...endCandidates);
  const query = agentEvents.map(eventInput).find(Boolean) ||
    llmEvents.map(eventInput).find(Boolean) ||
    'Pi Agent Session';
  const finalResult = [...agentEvents].reverse().map(eventOutput).find(Boolean) ||
    [...llmEvents].reverse().map(eventOutput).find(Boolean) ||
    '';
  const inputTokens = llmEvents.reduce((sum, event) => sum + (event.usage.input_tokens || 0), 0);
  const outputTokens = llmEvents.reduce((sum, event) => sum + (event.usage.output_tokens || 0), 0);
  const reasoningTokens = llmEvents.reduce((sum, event) => sum + (event.usage.reasoning_tokens || 0), 0);
  const cacheReadInputTokens = llmEvents.reduce(
    (sum, event) => sum + (Number(attrs(event)['pi.usage.cache_read']) || 0),
    0,
  );
  const cacheCreationInputTokens = llmEvents.reduce(
    (sum, event) => sum + (Number(attrs(event)['pi.usage.cache_write']) || 0),
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
  const model = llmEvents.map(eventModel).find(Boolean) || agentEvents.map(eventModel).find(Boolean) || 'unknown';

  return {
    task_id: sessionId,
    query,
    framework: 'pi-agent',
    model,
    tokens,
    latency: Math.max(0, endedAt - startedAt),
    final_result: finalResult,
    timestamp: new Date(startedAt),
    trace_completed_at: new Date(endedAt),
    // Pi 事件是从 task 全量 spool 重聚合的规范快照。显式标记允许历史 Generic 污染
    // 被更小但更正确的树替换，而不是被单调合并永久保留。
    session_merge_strategy: 'snapshot-replace',
    complete_session_snapshot: true,
    label: 'pi-agent',
    user: first.user || 'anonymous',
    interactions,
    invokedSkills,
    invoked_skills: invokedSkills,
    skills: invokedSkills.map((skill) => skill.name),
    agent: 'pi-agent',
    agentName: 'pi-agent',
    agents: Array.from(new Set([
      'pi-agent',
      ...ordered
        .filter((event) => semanticKind(event) === 'subagent')
        .map(agentName),
    ])),
    llm_call_count: llmEvents.length,
    tool_call_count: toolEvents.length,
    tool_call_error_count: toolErrors,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens || undefined,
    cache_read_input_tokens: cacheReadInputTokens || undefined,
    cache_creation_input_tokens: cacheCreationInputTokens || undefined,
    max_single_call_tokens: maxSingleCallTokens || undefined,
  };
}

export const piAgentOtelTraceAdapter: OtelTraceAdapter = {
  id: 'pi-agent',
  matches: (events) => events.some((event) => (
    event.serviceName === 'pi-agent' ||
    attrs(event)['agent.insight.framework'] === 'pi-agent'
  )),
  aggregate: aggregatePiAgentTraceEvents,
};
