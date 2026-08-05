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
  const value = content(attrs(event)['input.value'] ?? (event as AnyObj).input);
  // Codex emits this placeholder for lifecycle events when a prompt is not
  // exported. It is not a user task boundary and must not create a root.
  return value?.trim() === '[REDACTED]' ? undefined : value;
}

function eventOutput(event: OtelTraceEvent): string | undefined {
  const raw = event as AnyObj;
  return content(attrs(event)['output.value'] ?? attrs(event)['tool.result'] ?? raw.output ??
    (raw.tool as AnyObj | undefined)?.result);
}

function eventEndMs(event: OtelTraceEvent): number {
  const rawEnd = Number((event as AnyObj).endTimeMs);
  if (Number.isFinite(rawEnd) && rawEnd > 0) return rawEnd;
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function toIso(value: number): string {
  return new Date(value || Date.now()).toISOString();
}

function eventModel(event: OtelTraceEvent): string | undefined {
  return content(event.model || attrs(event)['llm.model_name'] || attrs(event)['gen_ai.request.model']);
}

function eventUsage(event: OtelTraceEvent) {
  const usage = (event.usage || {}) as AnyObj;
  const number = (snake: string, canonical: string) =>
    Number(usage[snake] ?? usage[canonical]) || 0;
  return {
    input: number('input_tokens', 'input'),
    output: number('output_tokens', 'output'),
    reasoning: number('reasoning_tokens', 'reasoning'),
    total: number('total_tokens', 'total'),
    cache: {
      read: Number(attrs(event)['codex.usage.cache_read']) || 0,
      write: 0,
    },
    input_tokens: number('input_tokens', 'input'),
    output_tokens: number('output_tokens', 'output'),
    reasoning_tokens: number('reasoning_tokens', 'reasoning'),
  };
}

function agentName(event: OtelTraceEvent): string {
  return content(attrs(event)['codex.agent.name']) ||
    String(event.name || '').replace(/^agent\./, '') ||
    'codex';
}

function toolName(event: OtelTraceEvent): string {
  return content(attrs(event)['tool.name'] ?? ((event as AnyObj).tool as AnyObj | undefined)?.name) ||
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

function subagentParentOwner(
  event: OtelTraceEvent,
  bySpanId: Map<string, OtelTraceEvent>,
): ReturnType<typeof ownerFor> {
  const directParent = event.parentSpanId ? bySpanId.get(event.parentSpanId) : undefined;
  if (directParent && semanticKind(directParent) === 'subagent') {
    return {
      event: directParent,
      name: agentName(directParent),
      sessionId: directParent.spanId,
    };
  }
  return ownerFor(directParent || event, bySpanId);
}

function ownerFields(owner: ReturnType<typeof ownerFor>): AnyObj {
  if (!owner.sessionId) return { role: 'assistant', agent: 'codex' };
  return {
    role: 'subagent',
    // Keep the framework identity stable for filtering. The specialised
    // execution role belongs in subagent_name, not in the Agent field.
    agent: 'codex',
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

function finalReplyInteraction(
  event: OtelTraceEvent,
  reply: string,
  model?: string,
): AnyObj {
  const completedAt = eventEndMs(event) || event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  return {
    role: 'assistant',
    agent: 'codex',
    content: reply,
    timestamp: toIso(completedAt),
    timeInfo: {
      created: toIso(completedAt),
      completed: toIso(completedAt),
    },
    traceId: event.traceId,
    spanId: `${event.spanId || event.traceId || 'codex-root'}:output`,
    parentSpanId: event.spanId,
    name: 'llm.final',
    source: 'hook-final-reply',
    turn_id: attrs(event)['codex.turn.id'],
    model: model || eventModel(event),
  };
}

function toolCall(event: OtelTraceEvent): AnyObj {
  const eventAttrs = attrs(event);
  const rawTool = (event as AnyObj).tool as AnyObj | undefined;
  const startedAt = event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  const completedAt = eventEndMs(event) || startedAt;
  const outcome = String(eventAttrs['tool.outcome'] || (event as AnyObj).status || '').toLowerCase();
  const output = eventOutput(event);
  return {
    id: event.spanId,
    type: 'function',
    state: ['error', 'failed'].includes(outcome) ? 'error' : 'success',
    function: {
      name: toolName(event),
      arguments: content(eventAttrs['tool.arguments'] ?? rawTool?.arguments) || '{}',
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
  if (Number.isFinite(parsed)) return parsed;
  // semver 如 "1.0.0"（skill frontmatter 常用格式）解析为整数主版本号
  const semver = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value).trim());
  return semver ? Number(semver[1]) : null;
}

function toolFamily(event: OtelTraceEvent): string {
  const normalized = toolName(event).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (['bash', 'exec', 'execcommand', 'powershell', 'pwsh', 'shellcommand', 'terminal']
    .includes(normalized)) {
    return 'shell';
  }
  return normalized;
}

function normalizedToolOutput(event: OtelTraceEvent): string {
  return (eventOutput(event) || '').replace(/\s+/g, ' ').trim();
}

function toolSource(event: OtelTraceEvent): string {
  return content(attrs(event)['codex.tool.source']) || '';
}

function hasToolSource(event: OtelTraceEvent, source: 'hook' | 'otel'): boolean {
  return toolSource(event).split('+').includes(source);
}

function isHookOtelToolPair(left: OtelTraceEvent, right: OtelTraceEvent): boolean {
  if (!['tool', 'mcp'].includes(semanticKind(left)) ||
    !['tool', 'mcp'].includes(semanticKind(right))) return false;
  const leftHasHook = hasToolSource(left, 'hook');
  const rightHasHook = hasToolSource(right, 'hook');
  const leftHasOtel = hasToolSource(left, 'otel');
  const rightHasOtel = hasToolSource(right, 'otel');
  if (!((leftHasHook && !rightHasHook && rightHasOtel) ||
    (rightHasHook && !leftHasHook && leftHasOtel))) return false;
  if (left.sessionId !== right.sessionId || left.parentSpanId !== right.parentSpanId) return false;
  if (toolFamily(left) !== toolFamily(right)) return false;

  const leftStart = left.startTimeMs || 0;
  const rightStart = right.startTimeMs || 0;
  const leftEnd = eventEndMs(left);
  const rightEnd = eventEndMs(right);
  if (Math.abs(leftStart - rightStart) > 2_000 || Math.abs(leftEnd - rightEnd) > 3_000) return false;
  if (Math.max(leftStart, rightStart) > Math.min(leftEnd, rightEnd) + 250) return false;

  const leftOutput = normalizedToolOutput(left);
  const rightOutput = normalizedToolOutput(right);
  return Boolean(leftOutput && rightOutput &&
    (leftOutput.includes(rightOutput) || rightOutput.includes(leftOutput)));
}

function mergeHookOtelTool(hook: OtelTraceEvent, otel: OtelTraceEvent): OtelTraceEvent {
  const startedAt = Math.min(hook.startTimeMs || 0, otel.startTimeMs || 0);
  const completedAt = Math.max(eventEndMs(hook), eventEndMs(otel));
  const merged = {
    ...otel,
    ...hook,
    startTimeMs: startedAt,
    latencyMs: Math.max(0, completedAt - startedAt),
    attributes: {
      ...attrs(otel),
      ...attrs(hook),
      'codex.tool.source': 'hook+otel',
      'codex.otel.call.id': attrs(otel)['codex.call.id'],
    },
  };
  (merged as AnyObj).endTimeMs = completedAt;
  return merged;
}

function mergeDirectCallIdTools(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const groups = new Map<string, OtelTraceEvent[]>();
  for (const event of events) {
    if (!['tool', 'mcp'].includes(semanticKind(event))) continue;
    const callId = content(attrs(event)['codex.call.id']);
    if (!callId) continue;
    const key = [event.sessionId, event.parentSpanId || '', toolFamily(event), callId].join('|');
    const group = groups.get(key) || [];
    group.push(event);
    groups.set(key, group);
  }

  const replacements = new Map<OtelTraceEvent, OtelTraceEvent>();
  const removed = new Set<OtelTraceEvent>();
  for (const group of groups.values()) {
    const hooks = group.filter((event) => hasToolSource(event, 'hook'));
    const otels = group.filter((event) => hasToolSource(event, 'otel'));
    if (hooks.length === 0 || otels.length === 0) continue;
    const hook = [...hooks].sort((left, right) => eventEndMs(right) - eventEndMs(left))[0];
    const merged = otels.reduce((current, otel) => mergeHookOtelTool(current, otel), hook);
    replacements.set(hook, merged);
    for (const event of group) if (event !== hook) removed.add(event);
  }

  return events.flatMap((event) => {
    const merged = replacements.get(event);
    if (merged) return [merged];
    return removed.has(event) ? [] : [event];
  });
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
  const snapshots = mergeDirectCallIdTools([...latest.values(), ...withoutSpan]);
  const hookTools = snapshots.filter((event) =>
    hasToolSource(event, 'hook') &&
    ['tool', 'mcp'].includes(semanticKind(event)));
  const otelTools = snapshots.filter((event) =>
    !hasToolSource(event, 'hook') && hasToolSource(event, 'otel') &&
    ['tool', 'mcp'].includes(semanticKind(event)));
  const hookMatches = new Map<OtelTraceEvent, OtelTraceEvent[]>();
  const otelMatches = new Map<OtelTraceEvent, OtelTraceEvent[]>();
  for (const hook of hookTools) {
    const matches = otelTools.filter((otel) => isHookOtelToolPair(hook, otel));
    hookMatches.set(hook, matches);
    for (const otel of matches) {
      const reverse = otelMatches.get(otel) || [];
      reverse.push(hook);
      otelMatches.set(otel, reverse);
    }
  }

  const mergedHooks = new Map<OtelTraceEvent, OtelTraceEvent>();
  const mergedOtels = new Set<OtelTraceEvent>();
  for (const [hook, matches] of hookMatches) {
    if (matches.length !== 1) continue;
    const otel = matches[0];
    if ((otelMatches.get(otel) || []).length !== 1) continue;
    mergedHooks.set(hook, mergeHookOtelTool(hook, otel));
    mergedOtels.add(otel);
  }

  return snapshots
    .flatMap((event) => {
      const merged = mergedHooks.get(event);
      if (merged) return [merged];
      return mergedOtels.has(event) ? [] : [event];
    })
    .sort((left, right) =>
      (left.startTimeMs || 0) - (right.startTimeMs || 0) ||
      String(left.spanId).localeCompare(String(right.spanId)));
}

function orderCodexEvents(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const compare = (left: OtelTraceEvent, right: OtelTraceEvent) =>
    (left.startTimeMs || 0) - (right.startTimeMs || 0) ||
    String(left.spanId).localeCompare(String(right.spanId));
  const chronological = [...events].sort(compare);
  const spanIds = new Set(chronological.flatMap((event) => event.spanId ? [event.spanId] : []));
  const children = new Map<string, OtelTraceEvent[]>();
  const roots: OtelTraceEvent[] = [];

  for (const event of chronological) {
    const parentId = event.parentSpanId;
    if (!parentId || parentId === event.spanId || !spanIds.has(parentId)) {
      roots.push(event);
      continue;
    }
    const siblings = children.get(parentId) || [];
    siblings.push(event);
    children.set(parentId, siblings);
  }

  for (const siblings of children.values()) siblings.sort(compare);
  const ordered: OtelTraceEvent[] = [];
  const visited = new Set<OtelTraceEvent>();
  const visit = (event: OtelTraceEvent) => {
    if (visited.has(event)) return;
    visited.add(event);
    ordered.push(event);
    if (event.spanId) for (const child of children.get(event.spanId) || []) visit(child);
  };

  // Parent spans must precede their child spans even when independently
  // timestamped Hook and OTel streams have a few milliseconds of clock skew.
  for (const event of roots) visit(event);
  for (const event of chronological) visit(event); // malformed cycles: keep all evidence
  return ordered;
}

export function aggregateCodexTraceEvents(
  sessionId: string,
  events: OtelTraceEvent[],
): ExecutionRecord | null {
  const ordered = orderCodexEvents(events.filter((event) => event.sessionId === sessionId));
  if (ordered.length === 0) return null;
  // An automatic unit without a unique/direct parent is retained in the spool
  // for a later correlated replay, but must never become a visible root task.
  if (ordered.every((event) => attrs(event)['codex.association.pending'] === 'true')) {
    return null;
  }

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
  const rootLlmEvents: OtelTraceEvent[] = [];
  const rootLlmInteractions: AnyObj[] = [];
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
      const parentOwner = subagentParentOwner(event, bySpanId);
      const outcome = String(attrs(event)['tool.outcome'] || '').toLowerCase();
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
          state: ['error', 'failed'].includes(outcome) ? 'error' : 'success',
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
      const interaction = {
        ...interactionBase(event, owner),
        content: eventOutput(event) || '',
        model: eventModel(event),
        provider: content(attrs(event)['llm.provider']),
        usage: eventUsage(event),
      };
      interactions.push(interaction);
      if (!owner.sessionId) {
        rootLlmEvents.push(event);
        rootLlmInteractions.push(interaction);
      }
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

  const delegated = ordered.some((event) =>
    attrs(event)['codex.delegated.session'] === 'true');
  const hasMeaningfulRootSignal = rootEvents.some((event) =>
    Boolean(eventInput(event) || eventOutput(event)));
  if (!hasMeaningfulRootSignal && llmEvents.length === 0 && toolEvents.length === 0 &&
    invokedSkills.length === 0 && subagentEvents.length === 0) {
    return null;
  }
  const first = ordered[0];
  // Execution 已按 turn 边界拆分；从根 agent 的开始到该 execution 内最后一个
  // child event 的结束，才能覆盖真实的 LLM、Tool、Skill 与子 Agent 链路。
  // 不能只取根生命周期 snapshot 的结束时间，否则根节点可能短于实际执行数分钟。
  const rootStarted = rootEvents
    .map((event) => event.startTimeMs || Date.parse(event.receivedAt) || Date.now())
    .sort((a, b) => a - b)[0];
  const startedAt = rootStarted ?? Math.min(...ordered.map((event) =>
    event.startTimeMs || Date.parse(event.receivedAt) || Date.now()));
  const endedAt = Math.max(...ordered.map(eventEndMs));
  const query = rootEvents.map(eventInput).find(Boolean) ||
    llmEvents.map(eventInput).find(Boolean) ||
    subagentEvents.map(eventInput).find(Boolean) ||
    (toolEvents.length > 0 ? `Codex tool: ${toolName(toolEvents[0])}` : 'Codex execution');
  const finalRootEvent = [...rootEvents].reverse().find((event) => Boolean(eventOutput(event)));
  const finalLlmEvent = [...rootLlmEvents].reverse().find((event) => Boolean(eventOutput(event)));
  const finalResult = finalRootEvent
    ? eventOutput(finalRootEvent) || ''
    : finalLlmEvent
      ? eventOutput(finalLlmEvent) || ''
      : '';
  if (finalResult) {
    const finalRootLlm = rootLlmInteractions[rootLlmInteractions.length - 1];
    const finalRootLlmIndex = finalRootLlm ? interactions.lastIndexOf(finalRootLlm) : -1;
    const existingReply = content(finalRootLlm?.content);
    if (finalRootLlm && finalRootLlmIndex === interactions.length - 1 && !existingReply) {
      // Native Codex OTel provides the final response timing/usage but not its
      // visible text. Hook Stop carries that text on the root Agent snapshot,
      // so complete the existing final LLM interaction instead of inventing a
      // second model call or changing its token/timing metrics.
      finalRootLlm.content = finalResult;
    } else if (!existingReply || existingReply.trim() !== finalResult.trim()) {
      // If no root LLM can safely own the reply (for example only a subagent
      // emitted LLM telemetry, or a Tool follows the last root LLM), retain the
      // canonical root answer as a stable terminal assistant interaction.
      const finalReplySource = finalRootEvent || finalLlmEvent || rootEvents[rootEvents.length - 1] || first;
      const finalRootLlmEvent = rootLlmEvents[rootLlmEvents.length - 1];
      const finalReplyModel = finalRootLlmEvent ? eventModel(finalRootLlmEvent) : undefined;
      interactions.push(finalReplyInteraction(finalReplySource, finalResult, finalReplyModel));
    }
  }
  const inputTokens = llmEvents.reduce((sum, event) => sum + eventUsage(event).input, 0);
  const outputTokens = llmEvents.reduce((sum, event) => sum + eventUsage(event).output, 0);
  const reasoningTokens = llmEvents.reduce(
    (sum, event) => sum + eventUsage(event).reasoning,
    0,
  );
  const cacheReadInputTokens = llmEvents.reduce(
    (sum, event) => sum + (Number(attrs(event)['codex.usage.cache_read']) || 0),
    0,
  );
  const tokens = llmEvents.reduce((sum, event) => {
    const usage = eventUsage(event);
    return sum + (usage.total || usage.input + usage.output);
  }, 0);
  const maxSingleCallTokens = Math.max(
    0,
    ...llmEvents.map((event) => {
      const usage = eventUsage(event);
      return usage.total || usage.input + usage.output;
    }),
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
    trace_started_at: new Date(startedAt),
    trace_completed_at: new Date(endedAt),
    session_merge_strategy: 'snapshot-replace',
    // The Codex relay reads the entire execution spool before aggregation. A
    // deduplicated rebuild may legitimately contain fewer interactions than a
    // stale pre-fix row, so it is safe to replace that row precisely.
    complete_session_snapshot: true,
    label: 'codex',
    user: first.user || 'anonymous',
    interactions,
    invokedSkills,
    invoked_skills: invokedSkills,
    skills: invokedSkills.map((skill) => skill.name),
    agent: 'codex',
    agentName: 'codex',
    agents: ['codex'],
    // spawn_agent 委派产生的 fork session：标记为子代理（不显示为独立主任务，
    // 见 issue-159-codex-open.md Bug 8）。parent 由后续关联或 UI 处理。
    ...(delegated ? { isSubagent: true, subagentName: 'subagent' } : {}),
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
    attrs(event)['agent.insight.framework'] === 'codex' ||
    (event as AnyObj).framework === 'codex'
  )),
  preprocessEvents: keepLatestCodexSpanSnapshots,
  aggregate: aggregateCodexTraceEvents,
};
