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
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
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
  return String(event.attributes?.['qoder.span.type'] || '').toLowerCase();
}

function snapshotCompletedAt(event: OtelTraceEvent): number {
  return Number(event.attributes?.['qoder.snapshot.completed_at_ms']) || eventEndMs(event);
}

function latestSnapshot(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const snapshots = new Map<string, { completedAt: number; events: OtelTraceEvent[] }>();
  for (const event of events) {
    const id = String(event.attributes?.['qoder.snapshot.id'] || 'legacy');
    const current = snapshots.get(id) || { completedAt: 0, events: [] };
    current.completedAt = Math.max(current.completedAt, snapshotCompletedAt(event));
    current.events.push(event);
    snapshots.set(id, current);
  }
  let selected: { completedAt: number; events: OtelTraceEvent[] } | undefined;
  for (const snapshot of snapshots.values()) {
    if (!selected || snapshot.completedAt >= selected.completedAt) selected = snapshot;
  }
  return selected?.events || [];
}

function eventUsage(event: OtelTraceEvent) {
  const attrs = event.attributes || {};
  const estimated = attrs['qoder.token_usage.estimated'] === true || attrs['qoder.token_usage.estimated'] === 'true';
  const input = estimated
    ? Number(attrs['qoder.token_usage.estimated_input_tokens']) || 0
    : event.usage?.input_tokens || 0;
  const output = estimated
    ? Number(attrs['qoder.token_usage.estimated_output_tokens']) || 0
    : event.usage?.output_tokens || 0;
  const reasoning = estimated ? 0 : event.usage?.reasoning_tokens || 0;
  const total = estimated
    ? Number(attrs['qoder.token_usage.estimated_total_tokens']) || input + output
    : event.usage?.total_tokens || input + output + reasoning;
  return {
    input,
    output,
    reasoning: reasoning || undefined,
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning || undefined,
    total,
    estimated,
    source: firstText(attrs['qoder.token_usage.source']),
    scope: firstText(attrs['qoder.token_usage.scope']),
    missing_context: attrs['qoder.token_usage.missing_context'] === true || attrs['qoder.token_usage.missing_context'] === 'true',
  };
}

function toolCall(event: OtelTraceEvent): AnyObj {
  const attrs = event.attributes || {};
  const started = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = eventEndMs(event) || started;
  const output = firstText(attrs['output.value'], attrs['tool.output'], attrs['tool.result']);
  const isError = Boolean(attrs['qoder.tool.is_error']) || String(attrs['tool.status'] || '').toLowerCase() === 'error';
  const originalName = firstText(attrs['tool.name'], event.name, 'tool') || 'tool';
  const args = parseJson(firstText(attrs['tool.arguments'], attrs['input.value'], '{}'));
  const argObject = args && typeof args === 'object' && !Array.isArray(args) ? args as AnyObj : {};
  const mcpServerName = firstText(attrs['mcp.server.name'], argObject.server_name, argObject.serverName);
  const mcpToolName = firstText(attrs['mcp.tool.name'], argObject.tool_name, argObject.toolName);
  const connectorName = firstText(attrs['qoder.connector.name']);
  const connectorToolName = firstText(attrs['qoder.connector.tool.name'], mcpToolName);
  const normalizedToolName = connectorName && connectorToolName
    ? `connector__${connectorName}__${connectorToolName}`
    : mcpServerName && mcpToolName
    ? `mcp__${mcpServerName}__${mcpToolName}`
    : originalName;
  const isQoderAgentTool = originalName.toLowerCase() === 'agent' && Boolean(
    argObject.subagent_type || argObject.subagentType || argObject.agent_type || argObject.agentType,
  );
  const parsedOutput = parseJson(output);
  const outputObject = parsedOutput && typeof parsedOutput === 'object' && !Array.isArray(parsedOutput)
    ? parsedOutput as AnyObj
    : undefined;
  const subagentSessionId = isQoderAgentTool
    ? firstText(
        outputObject?.subagent_session_id,
        outputObject?.session_id,
        outputObject?.agentId,
        outputObject?.agent_id,
        attrs['qoder.spawned_subagent.session_id'],
      )
    : undefined;
  const normalizedOutput = subagentSessionId
    ? outputObject
      ? { ...outputObject, subagent_session_id: subagentSessionId }
      : { subagent_session_id: subagentSessionId, result: output }
    : output;
  return {
    id: firstText(attrs['qoder.tool.use_id'], event.spanId),
    type: 'function',
    state: isError ? 'error' : 'success',
    original_tool_name: originalName,
    tool_type: connectorName && connectorToolName ? 'connector' : mcpServerName && mcpToolName ? 'mcp' : 'tool',
    mcp_server_name: mcpServerName,
    mcp_tool_name: mcpToolName,
    connector_name: connectorName,
    connector_tool_name: connectorToolName,
    function: {
      name: isQoderAgentTool ? 'task' : normalizedToolName,
      arguments: args,
    },
    output: normalizedOutput,
    result: normalizedOutput,
    exitCode: attrs['qoder.tool.exit_code'],
    timing: {
      started_at: toIso(started),
      completed_at: toIso(completed),
    },
  };
}

function questCall(event: OtelTraceEvent): AnyObj {
  const attrs = event.attributes || {};
  const kind = firstText(attrs['qoder.quest.kind'], 'step') || 'step';
  const status = String(attrs['qoder.quest.status'] || '').toLowerCase();
  const started = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completed = eventEndMs(event) || started;
  const args = kind === 'goal'
    ? {
        goalId: attrs['qoder.quest.goal_id'],
        mode: attrs['qoder.quest.mode'],
        objective: attrs['qoder.quest.objective'],
        status: attrs['qoder.quest.status'],
      }
    : {
        goalId: attrs['qoder.quest.goal_id'],
        stepId: attrs['qoder.quest.step_id'],
        description: attrs['qoder.quest.step_name'],
        status: attrs['qoder.quest.status'],
      };
  return {
    id: event.spanId,
    type: 'function',
    state: ['failed', 'error', 'cancelled'].includes(status) ? 'error' : 'success',
    original_tool_name: kind === 'goal' ? 'QuestGoal' : 'QuestStep',
    function: { name: kind === 'goal' ? 'quest_goal' : 'quest_step', arguments: args },
    output: firstText(attrs['output.value'], attrs['qoder.quest.status']),
    result: firstText(attrs['output.value'], attrs['qoder.quest.status']),
    timing: { started_at: toIso(started), completed_at: toIso(completed) },
  };
}

function isQoder(events: OtelTraceEvent[]): boolean {
  return events.some((event) => {
    const service = String(event.serviceName || '').toLowerCase();
    return service === 'qoder' || service.startsWith('qoder-') || event.attributes?.['qoder.session.id'] !== undefined;
  });
}

export function aggregateQoderOtelTraceEvents(sessionId: string, allEvents: OtelTraceEvent[]): ExecutionRecord | null {
  const events = latestSnapshot(allEvents.filter((event) => event.sessionId === sessionId));
  if (!events.length) return null;
  const ordered = [...events].sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  const root = ordered.find((event) => spanType(event) === 'agent') || ordered[0];
  const llmEvents = ordered.filter((event) => spanType(event) === 'llm');
  const toolEvents = ordered.filter((event) => spanType(event) === 'tool' || event.kind === 'tool');
  const subagentEvents = ordered.filter((event) => spanType(event) === 'subagent');
  const questEvents = ordered.filter((event) => spanType(event) === 'quest');
  const interactions: AnyObj[] = [];
  const rootAttrs = root.attributes || {};
  const product = (firstText(rootAttrs['qoder.product'], root.serviceName?.replace(/^qoder-(?:cn-)?/, ''), 'cli') || 'cli').toLowerCase();
  const productAgent = product.includes('desktop') || product === 'ide'
    ? 'Qoder CN Desktop'
    : product.includes('jetbrains')
      ? 'Qoder for JetBrains'
      : product.includes('work')
        ? 'Qoder Work'
        : 'Qoder CN CLI';
  const rootAgent = firstText(rootAttrs['qoder.agent.name'], productAgent) || productAgent;
  const sessionMode = firstText(rootAttrs['qoder.session.mode']);
  const explicitExpertEvents = subagentEvents.filter((event) => Boolean(firstText(
    event.attributes?.['qoder.expert.name'],
    event.attributes?.['qoder.expert.role'],
  )));
  const expertsMode = sessionMode?.toLowerCase() === 'experts';
  const expertsEnabled = rootAttrs['qoder.experts.enabled'] === true || rootAttrs['qoder.experts.enabled'] === 'true';
  const isExperts = expertsMode || expertsEnabled || explicitExpertEvents.length > 0;
  const expertEvents = explicitExpertEvents.length ? explicitExpertEvents : expertsMode ? subagentEvents : [];
  const query = firstText(rootAttrs['gen_ai.prompt'], rootAttrs['input.value'], 'Qoder session') || 'Qoder session';
  const rootStarted = root.startTimeMs || Date.parse(root.receivedAt) || Date.now();

  interactions.push({
    role: 'user',
    content: query,
    agent: rootAgent,
    qoder_mode: sessionMode,
    timestamp: toIso(rootStarted),
  });

  const assistantBySpanId = new Map<string, AnyObj>();
  const subagentBySessionId = new Map<string, AnyObj>();
  for (const event of llmEvents) {
    const attrs = event.attributes || {};
    const started = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
    const completed = eventEndMs(event) || started;
    const subagentSessionId = firstText(attrs['qoder.subagent.session_id']);
    const agentName = firstText(attrs['qoder.expert.name'], attrs['qoder.subagent.name'], attrs['qoder.agent.name'], rootAgent) || rootAgent;
    const interaction: AnyObj = {
      role: subagentSessionId ? 'subagent' : 'assistant',
      content: firstText(attrs['output.value'], attrs['gen_ai.completion'], '') || '',
      model: firstText(event.model, attrs['gen_ai.request.model'], 'unknown'),
      providerID: firstText(attrs['gen_ai.system'], 'qoder'),
      usage: eventUsage(event),
      timestamp: toIso(started),
      timeInfo: { created: toIso(started), completed: toIso(completed) },
      spanId: event.spanId,
      parentSpanId: event.parentSpanId,
      traceId: event.traceId,
      agent: agentName,
    };
    const input = firstText(attrs['input.value']);
    if (input) interaction.requestMessages = [{ role: 'user', content: input }];
    if (subagentSessionId) {
      interaction.subagent_name = agentName;
      interaction.subagent_session_id = subagentSessionId;
      interaction.subagent_type = firstText(attrs['qoder.subagent.type']);
      interaction.expert_name = firstText(attrs['qoder.expert.name']);
      interaction.expert_role = firstText(attrs['qoder.expert.role'], attrs['qoder.subagent.role']);
      subagentBySessionId.set(subagentSessionId, interaction);
    }
    interactions.push(interaction);
    if (event.spanId) assistantBySpanId.set(event.spanId, interaction);
  }

  for (const event of subagentEvents) {
    const attrs = event.attributes || {};
    const name = firstText(attrs['qoder.expert.name'], attrs['qoder.subagent.name'], 'subagent') || 'subagent';
    const subagentSessionId = firstText(attrs['qoder.subagent.session_id'], event.spanId) || event.spanId;
    const existing = subagentSessionId ? subagentBySessionId.get(subagentSessionId) : undefined;
    if (existing) {
      if (!existing.content) existing.content = firstText(attrs['output.value'], '') || '';
      existing.subagent_name = name;
      existing.agent = name;
      continue;
    }
    const interaction: AnyObj = {
      role: 'subagent',
      agent: name,
      subagent_name: name,
      subagent_type: firstText(attrs['qoder.subagent.type']),
      expert_name: firstText(attrs['qoder.expert.name']),
      expert_role: firstText(attrs['qoder.expert.role'], attrs['qoder.subagent.role']),
      subagent_session_id: subagentSessionId,
      content: firstText(attrs['output.value'], '') || '',
      model: firstText(event.model, attrs['gen_ai.request.model']),
      providerID: firstText(attrs['gen_ai.system'], 'qoder'),
      usage: eventUsage(event),
      timestamp: toIso(event.startTimeMs || Date.parse(event.receivedAt) || Date.now()),
      timeInfo: {
        created: toIso(event.startTimeMs || Date.parse(event.receivedAt) || Date.now()),
        completed: toIso(eventEndMs(event) || event.startTimeMs || Date.now()),
      },
    };
    interactions.push(interaction);
    if (subagentSessionId) subagentBySessionId.set(subagentSessionId, interaction);
  }

  const questSourceTools = new Set(['creategoal', 'updategoal', 'todowrite']);
  const visibleToolEvents = questEvents.length
    ? toolEvents.filter((event) => !questSourceTools.has(firstText(event.attributes?.['tool.name'], event.name, '')!.toLowerCase()))
    : toolEvents;
  const attachCall = (event: OtelTraceEvent, call: AnyObj) => {
    const ownerSubagentId = firstText(event.attributes?.['qoder.subagent.session_id']);
    const host = (ownerSubagentId ? subagentBySessionId.get(ownerSubagentId) : undefined) ||
      (event.parentSpanId ? assistantBySpanId.get(event.parentSpanId) : undefined) ||
      [...interactions].reverse().find((interaction) => {
        if (interaction.role !== 'assistant' && interaction.role !== 'subagent') return false;
        return Date.parse(String(interaction.timestamp || '')) <= (event.startTimeMs || Number.POSITIVE_INFINITY);
      }) || [...interactions].reverse().find((interaction) => interaction.role === 'assistant' || interaction.role === 'subagent');
    if (host) {
      host.tool_calls = Array.isArray(host.tool_calls) ? [...host.tool_calls, call] : [call];
    } else {
      interactions.push({
        role: 'assistant',
        content: '',
        agent: rootAgent,
        timestamp: toIso(event.startTimeMs || Date.parse(event.receivedAt) || Date.now()),
        tool_calls: [call],
      });
    }
  };
  for (const event of visibleToolEvents) {
    attachCall(event, toolCall(event));
  }
  for (const event of questEvents) {
    attachCall(event, questCall(event));
  }

  const finalResult = firstText(rootAttrs['gen_ai.completion'], rootAttrs['output.value'], [...interactions].reverse().find((item) => item.content)?.content, '') || '';
  const modelEvent = [...llmEvents].reverse().find((event) => event.model || event.attributes?.['gen_ai.request.model']);
  const usage = llmEvents.reduce((total, event) => {
    const current = eventUsage(event);
    total.input += current.input_tokens;
    total.output += current.output_tokens;
    total.reasoning += current.reasoning_tokens || 0;
    total.all += current.total;
    return total;
  }, { input: 0, output: 0, reasoning: 0, all: 0 });
  const tokenUsageAvailable = llmEvents.some((event) => {
    const explicit = event.attributes?.['qoder.token_usage.available'];
    return explicit === true || explicit === 'true' || eventUsage(event).total > 0;
  });
  const tokenUsageEstimated = llmEvents.some((event) => eventUsage(event).estimated);
  const rootCompleted = eventEndMs(root) || snapshotCompletedAt(root);

  return {
    task_id: sessionId,
    query,
    framework: 'qoder',
    model: firstText(modelEvent?.model, modelEvent?.attributes?.['gen_ai.request.model'], rootAttrs['gen_ai.request.model'], 'unknown'),
    tokens: tokenUsageAvailable ? usage.all : undefined,
    input_tokens: tokenUsageAvailable && !tokenUsageEstimated ? usage.input : undefined,
    output_tokens: tokenUsageAvailable && !tokenUsageEstimated ? usage.output : undefined,
    reasoning_tokens: tokenUsageAvailable && !tokenUsageEstimated && usage.reasoning ? usage.reasoning : undefined,
    token_usage_estimated: tokenUsageEstimated,
    latency: Math.max(0, rootCompleted - rootStarted) / 1000,
    final_result: finalResult,
    timestamp: new Date(rootStarted),
    trace_completed_at: rootAttrs['qoder.trace.completed'] ? new Date(rootCompleted) : null,
    label: `${rootAgent}${isExperts ? ' Experts' : ''}`,
    // normalizeOtlpTraces gives authenticated API-key ownership precedence
    // over client-provided attributes. The Qoder account hash is only a local
    // spool-isolation key and must never replace the real Agent Insight user.
    user: root.user || 'anonymous',
    authenticated_ingest: ordered.some((event) => event.authenticatedUser === true),
    interactions,
    qoder_quest: questEvents.length ? {
      mode: firstText(rootAttrs['qoder.session.mode'], questEvents[0]?.attributes?.['qoder.quest.mode']),
      goals: questEvents.filter((event) => event.attributes?.['qoder.quest.kind'] === 'goal').map((event) => ({
        id: event.attributes?.['qoder.quest.goal_id'],
        objective: event.attributes?.['qoder.quest.objective'],
        status: event.attributes?.['qoder.quest.status'],
      })),
      steps: questEvents.filter((event) => event.attributes?.['qoder.quest.kind'] === 'step').map((event) => ({
        id: event.attributes?.['qoder.quest.step_id'],
        description: event.attributes?.['qoder.quest.step_name'],
        status: event.attributes?.['qoder.quest.status'],
      })),
    } : undefined,
    qoder_experts: isExperts ? {
      mode: 'experts',
      members: expertEvents.map((event) => ({
        sessionId: event.attributes?.['qoder.subagent.session_id'],
        name: firstText(event.attributes?.['qoder.expert.name'], event.attributes?.['qoder.subagent.name']),
        role: firstText(event.attributes?.['qoder.expert.role'], event.attributes?.['qoder.subagent.role']),
        type: firstText(event.attributes?.['qoder.subagent.type']),
      })),
    } : undefined,
    agent: rootAgent,
    agentName: rootAgent,
    llm_call_count: llmEvents.length,
    tool_call_count: visibleToolEvents.length + questEvents.length,
    tool_call_error_count: [...visibleToolEvents, ...questEvents].filter((event) => {
      const attrs = event.attributes || {};
      return Boolean(attrs['qoder.tool.is_error']) || String(attrs['tool.status'] || '').toLowerCase() === 'error';
    }).length,
    // Qoder CN Desktop may reuse one session id across multiple independent turns.
    // Each upload is the current turn snapshot, so it must be allowed to replace
    // a larger previous turn and refresh the stored query.
    force_query_update: true,
    allow_snapshot_shrink: true,
    session_merge_strategy: 'snapshot-replace',
  };
}

export const qoderOtelTraceAdapter: OtelTraceAdapter = {
  id: 'qoder',
  matches: isQoder,
  aggregate: aggregateQoderOtelTraceEvents,
};
