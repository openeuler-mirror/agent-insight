import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';
import type { OtelTraceAdapter } from './types';

type AnyObj = Record<string, any>;

function content(value: any): string | undefined {
  if (value === undefined || value === null) return undefined;
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

function eventEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString();
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

function agentName(event: OtelTraceEvent | undefined): string | undefined {
  const attrs = event?.attributes || {};
  return firstContent(
    attrs['witty.agent.name'],
    attrs['gen_ai.agent.name'],
    attrs['agent.name'],
  );
}

function agentSessionId(event: OtelTraceEvent): string {
  const attrs = event.attributes || {};
  return firstContent(attrs['witty.agent.id'], attrs['agent.id'], event.spanId) || event.sessionId;
}

function dedupeAndSort(sessionId: string, events: OtelTraceEvent[]): OtelTraceEvent[] {
  const seen = new Set<string>();
  return events
    .filter((event) => event.sessionId === sessionId)
    .filter((event) => {
      const key = event.spanId
        ? `${event.traceId || ''}:${event.spanId}`
        : `${event.kind}:${event.name || ''}:${event.parentSpanId || ''}:${event.startTimeMs}:${JSON.stringify(event.attributes || {})}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => (left.startTimeMs || 0) - (right.startTimeMs || 0));
}

function isToolError(event: OtelTraceEvent): boolean {
  const attrs = event.attributes || {};
  const explicit = attrs['witty.tool.error'];
  if (explicit === true || String(explicit).toLowerCase() === 'true') return true;
  const outcome = String(
    attrs['tool.status'] || attrs['tool.outcome'] || attrs['error.type'] || attrs['error.message'] || '',
  ).toLowerCase();
  return outcome === 'error' || outcome === 'failed' || !!attrs['exception.message'];
}

function toolCall(event: OtelTraceEvent): AnyObj {
  const attrs = event.attributes || {};
  const skillName = firstContent(attrs['witty.skill.name']);
  const name = skillName
    ? 'skill'
    : firstContent(attrs['witty.tool.name'], attrs['tool.name'], event.name) || 'tool';
  const args = skillName
    ? {
        skill: skillName,
        ...(attrs['witty.skill.version'] !== undefined ? { version: attrs['witty.skill.version'] } : {}),
        ...(attrs['witty.skill.trigger_type'] !== undefined ? { trigger_type: attrs['witty.skill.trigger_type'] } : {}),
      }
    : firstContent(
        attrs['witty.tool.input'],
        attrs['tool.arguments'],
        attrs['input.value'],
      ) || '';
  const output = firstContent(
    attrs['witty.tool.result'],
    attrs['tool.result'],
    attrs['tool.output'],
    attrs['output.value'],
    attrs['error.message'],
  );
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  return {
    id: event.spanId,
    type: 'function',
    state: isToolError(event) ? 'error' : 'completed',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
    output,
    result: output,
    timing: {
      started_at: toIso(created),
      completed_at: toIso(eventEndMs(event) || created),
    },
  };
}

function assistantInteraction(event: OtelTraceEvent, owner: OtelTraceEvent | undefined, root: OtelTraceEvent | undefined): AnyObj {
  const attrs = event.attributes || {};
  const prompt = firstContent(attrs['gen_ai.prompt'], attrs['input.value']);
  const completion = firstContent(attrs['gen_ai.completion'], attrs['output.value']);
  const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const ownerName = agentName(owner) || agentName(event) || event.serviceName || 'openclaw';
  const isSubagent = !!owner && !!root && owner.spanId !== root.spanId;
  return {
    role: isSubagent ? 'subagent' : 'assistant',
    content: completion || '',
    agent: ownerName,
    ...(isSubagent ? {
      subagent_name: ownerName,
      subagent_session_id: agentSessionId(owner),
    } : {}),
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
    timeInfo: { created: toIso(created), completed: toIso(eventEndMs(event) || created) },
    requestMessages: prompt ? [{ role: 'user', content: prompt }] : undefined,
    tool_calls: [],
    _orderMs: created,
    _ownerSpanId: owner?.spanId || root?.spanId || 'root',
  };
}

function cleanQuery(raw: string | undefined): string {
  if (!raw) return '';
  if (/^[A-Z]?:?[/\\]/.test(raw) || raw.includes('node_modules') || raw.includes('.agent-insight')) return '';
  return raw.trim();
}

export function aggregateOpenClawOtelTraceEvents(sessionId: string, inputEvents: OtelTraceEvent[]): ExecutionRecord | null {
  const events = dedupeAndSort(sessionId, inputEvents);
  if (!events.length) return null;

  const byId = new Map(events.filter((event) => event.spanId).map((event) => [event.spanId!, event]));
  const nearestAgent = (event: OtelTraceEvent, includeSelf = false): OtelTraceEvent | undefined => {
    let current: OtelTraceEvent | undefined = includeSelf && event.kind === 'agent'
      ? event
      : event.parentSpanId ? byId.get(event.parentSpanId) : undefined;
    const visited = new Set<string>();
    while (current) {
      if (current.kind === 'agent') return current;
      if (!current.parentSpanId || visited.has(current.parentSpanId)) return undefined;
      visited.add(current.parentSpanId);
      current = byId.get(current.parentSpanId);
    }
    return undefined;
  };

  const agentEvents = events.filter((event) => event.kind === 'agent');
  const rootAgent = agentEvents.find((event) => !nearestAgent(event)) || agentEvents[0];
  const rootAgentName = agentName(rootAgent) || events.map((event) => agentName(event)).find(Boolean) || 'openclaw';
  const interactions: AnyObj[] = [];
  const interactionBySpanId = new Map<string, AnyObj>();
  const interactionsByOwner = new Map<string, AnyObj[]>();

  const ownerKey = (owner: OtelTraceEvent | undefined) => owner?.spanId || rootAgent?.spanId || 'root';
  const remember = (interaction: AnyObj, owner: OtelTraceEvent | undefined) => {
    interactions.push(interaction);
    const key = ownerKey(owner);
    const list = interactionsByOwner.get(key) || [];
    list.push(interaction);
    interactionsByOwner.set(key, list);
  };
  const hostFor = (event: OtelTraceEvent, owner: OtelTraceEvent | undefined): AnyObj | undefined => {
    if (event.parentSpanId && interactionBySpanId.has(event.parentSpanId)) {
      return interactionBySpanId.get(event.parentSpanId);
    }
    const candidates = interactionsByOwner.get(ownerKey(owner)) || [];
    return [...candidates].reverse().find((candidate) => candidate._orderMs <= (event.startTimeMs || 0)) || candidates[0];
  };
  const ensureHost = (event: OtelTraceEvent, owner: OtelTraceEvent | undefined): AnyObj => {
    const existing = hostFor(event, owner);
    if (existing) return existing;
    const created = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
    const isSubagent = !!owner && !!rootAgent && owner.spanId !== rootAgent.spanId;
    const ownerName = agentName(owner) || rootAgentName;
    const interaction: AnyObj = {
      role: isSubagent ? 'subagent' : 'assistant',
      content: '',
      agent: ownerName,
      ...(isSubagent ? { subagent_name: ownerName, subagent_session_id: agentSessionId(owner!) } : {}),
      tool_calls: [],
      timeInfo: { created: toIso(created) },
      _orderMs: created,
      _ownerSpanId: ownerKey(owner),
    };
    remember(interaction, owner);
    return interaction;
  };

  for (const event of events) {
    if (event.kind !== 'llm') continue;
    const owner = nearestAgent(event) || rootAgent;
    const interaction = assistantInteraction(event, owner, rootAgent);
    remember(interaction, owner);
    if (event.spanId) interactionBySpanId.set(event.spanId, interaction);
  }

  const subagents = agentEvents.filter((event) => event !== rootAgent);
  for (const subagent of subagents) {
    const parentOwner = nearestAgent(subagent) || rootAgent;
    const host = ensureHost(subagent, parentOwner);
    const childName = agentName(subagent) || 'subagent';
    const childSessionId = agentSessionId(subagent);
    const childFinal = [...interactionsByOwner.get(ownerKey(subagent)) || []]
      .reverse()
      .find((interaction) => interaction.content)?.content;
    const call = {
      id: subagent.spanId,
      type: 'function',
      state: 'completed',
      function: {
        name: 'task',
        arguments: JSON.stringify({
          subagent_type: childName,
          subagent_session_id: childSessionId,
        }),
      },
      output: childFinal,
      result: childFinal,
      timing: {
        started_at: toIso(subagent.startTimeMs || Date.parse(subagent.receivedAt) || Date.now()),
        completed_at: toIso(eventEndMs(subagent) || subagent.startTimeMs),
      },
    };
    host.tool_calls = Array.isArray(host.tool_calls) ? [...host.tool_calls, call] : [call];
  }

  const toolEvents = events.filter((event) => event.kind === 'tool');
  for (const event of toolEvents) {
    const owner = nearestAgent(event) || rootAgent;
    const host = ensureHost(event, owner);
    host.tool_calls = Array.isArray(host.tool_calls)
      ? [...host.tool_calls, toolCall(event)]
      : [toolCall(event)];
  }

  interactions.sort((left, right) => left._orderMs - right._orderMs);
  const cleanInteractions = interactions.map(({ _orderMs, _ownerSpanId, ...interaction }) => interaction);
  const rootInteractions = cleanInteractions.filter((interaction) => interaction.role !== 'subagent');
  const firstPrompt = rootInteractions.find((interaction) => interaction.requestMessages?.[0]?.content)
    || cleanInteractions.find((interaction) => interaction.requestMessages?.[0]?.content);
  const lastContent = [...cleanInteractions].reverse().find((interaction) => content(interaction.content));
  const llmEvents = events.filter((event) => event.kind === 'llm');
  const modelEvent = llmEvents.find((event) => eventModel(event));
  const starts = events.map((event) => event.startTimeMs).filter((value) => value > 0);
  const ends = events.map(eventEndMs).filter((value) => value > 0);
  const invokedSkills = toolEvents
    .filter((event) => firstContent(event.attributes?.['witty.skill.name']))
    .map((event) => ({
      name: firstContent(event.attributes?.['witty.skill.name'])!,
      version: Number.isFinite(Number(event.attributes?.['witty.skill.version']))
        ? Number(event.attributes?.['witty.skill.version'])
        : null,
    }));
  const uniqueSkills = invokedSkills.filter((skill, index) =>
    invokedSkills.findIndex((candidate) => candidate.name === skill.name) === index,
  );
  const agentNames = agentEvents.map(agentName).filter((value): value is string => !!value);

  return {
    task_id: sessionId,
    query: cleanQuery(firstPrompt?.requestMessages?.[0]?.content) || 'OpenClaw Task',
    framework: 'openclaw',
    model: modelEvent ? eventModel(modelEvent) || 'unknown' : 'unknown',
    tokens: llmEvents.reduce((sum, event) => sum + tokenTotal(event), 0),
    latency: starts.length && ends.length ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : 0,
    final_result: lastContent?.content || '',
    timestamp: new Date(Math.min(...starts) || Date.parse(events[0].receivedAt) || Date.now()),
    trace_completed_at: ends.length ? toIso(Math.max(...ends)) : undefined,
    label: 'openclaw',
    user: events.map((event) => event.user).find((value) => value?.trim()) || null,
    interactions: cleanInteractions,
    agent: rootAgentName,
    agentName: rootAgentName,
    agents: Array.from(new Set([rootAgentName, ...agentNames])),
    skills: uniqueSkills.map((skill) => skill.name),
    invokedSkills: uniqueSkills,
    llm_call_count: llmEvents.length,
    tool_call_count: toolEvents.length,
    tool_call_error_count: toolEvents.filter(isToolError).length,
    input_tokens: llmEvents.reduce((sum, event) => sum + event.usage.input_tokens, 0),
    output_tokens: llmEvents.reduce((sum, event) => sum + event.usage.output_tokens, 0),
    reasoning_tokens: llmEvents.reduce((sum, event) => sum + (event.usage.reasoning_tokens || 0), 0) || undefined,
    session_merge_strategy: 'snapshot-replace',
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
