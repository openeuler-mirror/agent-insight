import type {
  ExecutionRecord,
  InvokedSkill,
  TraceThreadEventRecord,
  TraceThreadRecord,
} from '@/lib/storage/data-service';
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

function inputHistory(event: OtelTraceEvent): AnyObj[] {
  const raw = attrs(event)['codex.input.history'];
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is AnyObj => Boolean(item && typeof item === 'object'))
      : [];
  } catch {
    return [];
  }
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

function agentName(event: OtelTraceEvent, displayNames?: Map<string, string>): string {
  const mapped = event.spanId ? displayNames?.get(event.spanId) : undefined;
  if (mapped) return mapped;
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
  displayNames?: Map<string, string>,
): { event?: OtelTraceEvent; name: string; sessionId?: string } {
  let parentId = event.parentSpanId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = bySpanId.get(parentId);
    if (!parent) break;
    if (semanticKind(parent) === 'subagent') {
      return { event: parent, name: agentName(parent, displayNames), sessionId: parent.spanId };
    }
    parentId = parent.parentSpanId;
  }
  return { name: 'codex' };
}

function codexOwnerFor(
  event: OtelTraceEvent,
  bySpanId: Map<string, OtelTraceEvent>,
  displayNames?: Map<string, string>,
): ReturnType<typeof ownerFor> {
  const owner = ownerFor(event, bySpanId, displayNames);
  if (!owner.sessionId || semanticKind(event) !== 'llm') return owner;
  const child = owner.event;
  const childStartedAt = child?.startTimeMs || 0;
  // Codex can export root response.completed only after a worker has been
  // started. Its response start remains before the child lifecycle, so retain
  // root ownership instead of using the collector's later active-agent state.
  if (childStartedAt > 0 && (event.startTimeMs || 0) < childStartedAt) {
    return { name: 'codex' };
  }
  return owner;
}

function subagentParentOwner(
  event: OtelTraceEvent,
  bySpanId: Map<string, OtelTraceEvent>,
  displayNames?: Map<string, string>,
): ReturnType<typeof ownerFor> {
  const directParent = event.parentSpanId ? bySpanId.get(event.parentSpanId) : undefined;
  if (directParent && semanticKind(directParent) === 'subagent') {
    return {
      event: directParent,
      name: agentName(directParent, displayNames),
      sessionId: directParent.spanId,
    };
  }
  return ownerFor(directParent || event, bySpanId, displayNames);
}

function spawnTaskName(event: OtelTraceEvent): string | undefined {
  const raw = event as AnyObj;
  const rawTool = raw.tool as AnyObj | undefined;
  const value = attrs(event)['tool.arguments'] ?? rawTool?.arguments;
  let parsed: AnyObj | undefined;
  if (value && typeof value === 'object') parsed = value as AnyObj;
  else if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as AnyObj; } catch { /* malformed tool args */ }
  }
  const direct = content(parsed?.task_name);
  if (direct) return direct.replace(/^\/root\//, '');
  const result = eventOutput(event);
  if (result) {
    try {
      const parsedResult = JSON.parse(result) as AnyObj;
      const fromResult = content(parsedResult?.task_name);
      if (fromResult) return fromResult.replace(/^\/root\//, '');
    } catch { /* result is not structured JSON */ }
  }
  return undefined;
}

function inferSubagentDisplayNames(
  events: OtelTraceEvent[],
): Map<string, string> {
  const spawns = events
    .filter((event) => semanticKind(event) === 'tool' &&
      /(?:spawn_agent|spawnagent|collaboration)/i.test(toolName(event)))
    .map((event) => ({ event, name: spawnTaskName(event) }))
    .filter((item): item is { event: OtelTraceEvent; name: string } => Boolean(item.name));
  const names = new Map<string, string>();
  const usedSpawns = new Set<OtelTraceEvent>();
  for (const child of events.filter((event) => semanticKind(event) === 'subagent')) {
    const runtimeName = content(attrs(child)['codex.agent.name']) ||
      String(child.name || '').replace(/^agent\./, '');
    // A real Codex runtime role wins. `default` is the CLI's sentinel for a
    // worker created by collaboration.spawn_agent, so only that sentinel may
    // be replaced by the user-facing task_name.
    if (!['', 'default'].includes(runtimeName.trim().toLowerCase())) continue;
    const childStart = child.startTimeMs || 0;
    const childConversation = content(attrs(child)['codex.conversation.id']);
    const candidates = spawns.filter(({ event }) => {
      if (usedSpawns.has(event)) return false;
      // The worker is a forked execution: its session/trace ids are different
      // from the parent spawn tool. Codex keeps the conversation id stable,
      // which is the safe cross-execution association key.
      const spawnConversation = content(attrs(event)['codex.conversation.id']);
      if (!childConversation || !spawnConversation || childConversation !== spawnConversation) return false;
      return (event.startTimeMs || 0) <= childStart;
    });
    if (candidates.length === 0) continue;
    candidates.sort((left, right) =>
      Math.abs(childStart - (right.event.startTimeMs || 0)) -
      Math.abs(childStart - (left.event.startTimeMs || 0)));
    const nearest = candidates[candidates.length - 1];
    const previous = candidates[candidates.length - 2];
    const nearestDistance = Math.abs(childStart - (nearest.event.startTimeMs || 0));
    const previousDistance = previous ? Math.abs(childStart - (previous.event.startTimeMs || 0)) : Infinity;
    if (nearestDistance < previousDistance) {
      names.set(child.spanId || '', nearest.name);
      usedSpawns.add(nearest.event);
    }
  }
  return names;
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
    source_kind: attrs(event)['codex.source.kind'],
    source_thread_id: attrs(event)['codex.source.thread_id'],
    source_execution_id: attrs(event)['codex.source.execution_id'],
    execution_status: attrs(event)['codex.execution.status'],
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

function finalSubagentReplyInteraction(
  event: OtelTraceEvent,
  owner: ReturnType<typeof ownerFor>,
  reply: string,
  model?: string,
): AnyObj {
  const completedAt = eventEndMs(event) || event.startTimeMs || Date.parse(event.receivedAt) || Date.now();
  return {
    ...ownerFields(owner),
    content: reply,
    timestamp: toIso(completedAt),
    timeInfo: {
      created: toIso(completedAt),
      completed: toIso(completedAt),
    },
    traceId: event.traceId,
    spanId: `${event.spanId || event.traceId || 'codex-subagent'}:output`,
    parentSpanId: event.spanId,
    name: 'llm.subagent.final',
    source: 'hook-subagent-final-reply',
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

function reparentPreChildLlms(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const bySpanId = new Map(
    events.filter((event) => event.spanId).map((event) => [event.spanId!, event]),
  );
  return events.map((event) => {
    if (semanticKind(event) !== 'llm') return event;
    let parentId = event.parentSpanId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = bySpanId.get(parentId);
      if (!parent) break;
      if (semanticKind(parent) === 'subagent') {
        const childStartedAt = parent.startTimeMs || 0;
        if (childStartedAt > 0 && (event.startTimeMs || 0) < childStartedAt) {
          return { ...event, parentSpanId: parent.parentSpanId };
        }
        break;
      }
      parentId = parent.parentSpanId;
    }
    return event;
  });
}

function parsedObject(value: unknown): AnyObj {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as AnyObj;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AnyObj : {};
  } catch {
    return {};
  }
}

function buildTraceThread(events: OtelTraceEvent[]): TraceThreadRecord | undefined {
  const sourceThreadId = events
    .map((event) => content(attrs(event)['codex.source.thread_id'] || attrs(event)['codex.conversation.id']))
    .find(Boolean);
  if (!sourceThreadId) return undefined;
  const sourceKind = events.map((event) => content(attrs(event)['codex.source.kind'])).find(Boolean);
  const records = new Map<string, TraceThreadEventRecord>();

  for (const event of events) {
    const eventAttrs = attrs(event);
    const lifecycle = content(eventAttrs['agent.insight.lifecycle']);
    const sourceExecutionId = content(eventAttrs['codex.source.execution_id'] || eventAttrs['codex.turn.id']);
    if (lifecycle === 'thread_event') {
      const previousSourceExecutionId = content(eventAttrs['codex.thread.previous_execution_id']);
      const nextSourceExecutionId = content(eventAttrs['codex.thread.next_execution_id']);
      const eventKey = content(eventAttrs['codex.thread.event_id']) || event.spanId ||
        `codex:${sourceThreadId}:transition:${previousSourceExecutionId}:${nextSourceExecutionId}`;
      records.set(eventKey, {
        eventKey,
        kind: content(eventAttrs['codex.thread.event_kind']) || 'execution_transition',
        status: 'completed',
        sourceTurnId: previousSourceExecutionId,
        relatedSourceTurnId: nextSourceExecutionId,
        startedAt: new Date(event.startTimeMs || Date.parse(event.receivedAt) || Date.now()),
        completedAt: new Date(eventEndMs(event)),
        payload: {
          previousSourceExecutionId,
          nextSourceExecutionId,
          transitionKind: content(eventAttrs['codex.thread.transition_kind']) || 'interrupt_followed_by_execution',
          confidence: content(eventAttrs['codex.thread.confidence']) || 'pending',
          sourceKind,
        },
      });
    }

    if (lifecycle === 'compaction') {
      const itemId = content(eventAttrs['codex.compaction.item_id']) || event.spanId || String(event.startTimeMs || 'unknown');
      const eventKey = `codex:${sourceThreadId}:compaction:${itemId}`;
      const rawPayload = parsedObject(eventAttrs['codex.compaction.payload']);
      const maintenanceUsage = parsedObject(rawPayload.maintenanceUsage || rawPayload.maintenance_usage);
      records.set(eventKey, {
        eventKey,
        kind: 'context_compaction',
        status: content(eventAttrs['codex.compaction.status']) || 'completed',
        startedAt: new Date(event.startTimeMs || Date.parse(event.receivedAt) || Date.now()),
        completedAt: new Date(eventEndMs(event)),
        payload: {
          sourceKind,
          itemId,
          durationMs: Number(eventAttrs['codex.compaction.duration_ms']) || Math.max(0, eventEndMs(event) - (event.startTimeMs || 0)),
          windowId: content(rawPayload.window_id || rawPayload.windowId),
          previousWindowId: content(rawPayload.previous_window_id || rawPayload.previousWindowId),
          firstWindowId: content(rawPayload.first_window_id || rawPayload.firstWindowId),
          windowNumber: Number(rawPayload.window_number ?? rawPayload.windowNumber) || undefined,
          ...(Object.keys(maintenanceUsage).length > 0 ? { maintenanceUsage } : {}),
        },
      });
    }

    if (lifecycle === 'execution' && sourceExecutionId) {
      for (const input of inputHistory(event)) {
        if (content(input.input_kind) !== 'steer') continue;
        const phaseId = content(input.phase_id);
        const clientMessageId = content(input.client_message_id);
        const inputIndex = Number(input.input_index);
        const eventKey = `codex:${sourceThreadId}:steer:${sourceExecutionId}:${clientMessageId || phaseId || inputIndex}`;
        records.set(eventKey, {
          eventKey,
          kind: 'input_steer',
          status: 'completed',
          sourceTurnId: sourceExecutionId,
          phaseId,
          startedAt: input.timestamp ? new Date(String(input.timestamp)) : new Date(event.startTimeMs || Date.now()),
          completedAt: input.timestamp ? new Date(String(input.timestamp)) : new Date(event.startTimeMs || Date.now()),
          payload: {
            sourceKind,
            inputIndex: Number.isFinite(inputIndex) ? inputIndex : undefined,
            clientMessageId,
            confidence: 'direct',
          },
        });
      }
      if (content(eventAttrs['codex.execution.status']) === 'interrupted') {
        const eventKey = `codex:${sourceThreadId}:interrupt:${sourceExecutionId}`;
        records.set(eventKey, {
          eventKey,
          kind: 'interrupt',
          status: 'completed',
          sourceTurnId: sourceExecutionId,
          startedAt: new Date(eventEndMs(event)),
          completedAt: new Date(eventEndMs(event)),
          payload: { sourceKind, reason: 'interrupted', confidence: 'direct' },
        });
      }
    }
  }

  const startedAt = Math.min(...events.map((event) => event.startTimeMs || Date.parse(event.receivedAt) || Date.now()));
  const updatedAt = Math.max(...events.map(eventEndMs));
  return {
    sourceThreadId,
    sourceKind,
    startedAt: new Date(startedAt),
    updatedAt: new Date(updatedAt),
    metadata: { sourceKind },
    events: [...records.values()].sort((left, right) =>
      new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime()),
  };
}

export function aggregateCodexTraceEvents(
  sessionId: string,
  events: OtelTraceEvent[],
): ExecutionRecord | null {
  const ordered = orderCodexEvents(reparentPreChildLlms(
    events.filter((event) => event.sessionId === sessionId),
  ));
  if (ordered.length === 0) return null;
  // An automatic unit without a unique/direct parent is retained in the spool
  // for a later correlated replay, but must never become a visible root task.
  if (ordered.every((event) => attrs(event)['codex.association.pending'] === 'true')) {
    return null;
  }

  const bySpanId = new Map(
    ordered.filter((event) => event.spanId).map((event) => [event.spanId!, event]),
  );
  const displayNames = inferSubagentDisplayNames(ordered);
  const interactions: AnyObj[] = [];
  const invokedSkills: InvokedSkill[] = [];
  const skillNames = new Set<string>();
  const llmEvents: OtelTraceEvent[] = [];
  const toolEvents: OtelTraceEvent[] = [];
  const rootEvents: OtelTraceEvent[] = [];
  const subagentEvents: OtelTraceEvent[] = [];
  const rootLlmEvents: OtelTraceEvent[] = [];
  const rootLlmInteractions: AnyObj[] = [];
  const pendingSubagentOutcomes: Array<{ event: OtelTraceEvent; interaction: AnyObj }> = [];
  let toolErrors = 0;

  for (const event of ordered) {
    const kind = semanticKind(event);
    const owner = codexOwnerFor(event, bySpanId, displayNames);
    if (attrs(event)['agent.insight.lifecycle'] === 'compaction') {
      interactions.push({
        role: 'system',
        type: 'context_compaction',
        content: '',
        timestamp: toIso(event.startTimeMs),
        timeInfo: {
          created: toIso(event.startTimeMs),
          completed: toIso(eventEndMs(event)),
        },
        traceId: event.traceId,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        source_kind: attrs(event)['codex.source.kind'],
        compaction_status: attrs(event)['codex.compaction.status'],
        compaction_item_id: attrs(event)['codex.compaction.item_id'],
        compaction_duration_ms: attrs(event)['codex.compaction.duration_ms'],
      });
      continue;
    }
    if (kind === 'agent') {
      rootEvents.push(event);
      const history = inputHistory(event);
      const inputs = history.length > 0 ? history : (eventInput(event) ? [{
        content: eventInput(event),
        input_kind: 'initial',
        input_index: 0,
        phase_id: 'phase-0',
      }] : []);
      for (const input of inputs) {
        const contentValue = content(input.content ?? input.input ?? input.prompt);
        if (!contentValue) continue;
        interactions.push({
          role: 'user',
          agent: 'codex',
          content: contentValue,
          timestamp: input.timestamp || toIso(event.startTimeMs),
          timeInfo: {
            created: input.timestamp || toIso(event.startTimeMs),
            completed: input.timestamp || toIso(event.startTimeMs),
          },
          traceId: event.traceId,
          spanId: `${event.spanId}:input:${input.input_index ?? 0}`,
          parentSpanId: event.spanId,
          turn_id: attrs(event)['codex.turn.id'],
          input_kind: input.input_kind,
          input_index: input.input_index,
          phase_id: input.phase_id,
          client_message_id: input.client_message_id,
          source: input.source || attrs(event)['codex.source.kind'],
        });
      }
      continue;
    }

    if (kind === 'subagent') {
      subagentEvents.push(event);
      const subagent = agentName(event, displayNames);
      const parentOwner = subagentParentOwner(event, bySpanId, displayNames);
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
      const interaction = {
        ...interactionBase(event, { event, name: subagent, sessionId: event.spanId }),
        content: eventOutput(event) || '',
        model: eventModel(event),
        usage: eventUsage(event),
      };
      // SubagentStop is a lifecycle snapshot whose output is produced after the
      // child's work. Parent-before-child ordering would otherwise place that
      // result before every child LLM/Tool in the rendered tree.
      pendingSubagentOutcomes.push({ event, interaction });
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

  const first = ordered[0];
  const traceThread = buildTraceThread(ordered);
  const sourceKind = traceThread?.sourceKind || ordered
    .map((event) => content(attrs(event)['codex.source.kind']))
    .find(Boolean);
  const sourceThreadId = traceThread?.sourceThreadId;
  const sourceExecutionId = ordered
    .map((event) => content(attrs(event)['codex.source.execution_id'] || attrs(event)['codex.turn.id']))
    .find(Boolean);

  for (const { event, interaction } of pendingSubagentOutcomes) {
    const childInteractions = interactions.filter((candidate) =>
      candidate.subagent_session_id === event.spanId);
    const hasChildActivity = childInteractions.length > 0;
    // The TASK spawn interaction already carries the worker's final output.
    // When the child has its own LLM/Tool stream, retain native LLM telemetry
    // unchanged and emit the lifecycle result as its own terminal reply. Codex
    // can export several LLM snapshots whose start spans overlap tool work, so
    // no individual native LLM span can safely represent this Stop-time result.
    const outcome = eventOutput(event);
    const lastChildLlmEvent = [...ordered].reverse().find((candidate) =>
      semanticKind(candidate) === 'llm' && ownerFor(candidate, bySpanId, displayNames).sessionId === event.spanId);
    const childLlmAlreadyHasOutput = Boolean(lastChildLlmEvent && eventOutput(lastChildLlmEvent));
    const hasChildTool = childInteractions.some((candidate) =>
      Array.isArray(candidate.tool_calls) && candidate.tool_calls.length > 0);
    if (outcome && !childLlmAlreadyHasOutput && hasChildTool) {
      const childOwner = { event, name: agentName(event, displayNames), sessionId: event.spanId };
      interactions.push(finalSubagentReplyInteraction(
        event,
        childOwner,
        outcome,
        lastChildLlmEvent ? eventModel(lastChildLlmEvent) : undefined,
      ));
      continue;
    }
    if (hasChildActivity) continue;
    const childEnd = eventEndMs(event);
    let insertAfter = -1;
    for (let index = interactions.length - 1; index >= 0; index -= 1) {
      const candidate = interactions[index];
      if (candidate.subagent_session_id !== event.spanId) continue;
      const candidateTimeInfo = candidate.timeInfo as AnyObj | undefined;
      const candidateStart = Date.parse(String(candidateTimeInfo?.created || candidate.timestamp || ''));
      if (!Number.isFinite(candidateStart) || candidateStart <= childEnd) {
        insertAfter = index;
        break;
      }
    }
    // A lifecycle-only child still needs to claim the matching TASK spawn. The
    // claim must appear after the parent spawn interaction, otherwise the call
    // tree sees the child first and cannot construct its TASK node.
    interactions.splice(insertAfter >= 0 ? insertAfter + 1 : interactions.length, 0, interaction);
  }

  const delegated = ordered.some((event) =>
    attrs(event)['codex.delegated.session'] === 'true');
  // Codex 内部会话（任务标题生成、建议生成、worker 系统提示词等）以根 agent
  // input 出现但没有任何真实工作。只凭根 input/输出会把这些内部会话当成用户
  // 任务；必须保留"有真实工作（LLM/Tool/Skill/子 Agent）或生命周期执行信号"
  // 的可见执行。没有工作、也没有生命周期、且根 input 是 Codex 内部系统提示词
  // 的会话不生成可见执行记录。
  const INTERNAL_ROOT_INPUT = /(?:You are a helpful assistant|You are in a fork of an existing Codex thread|You are an expert at upholding safety|hyperpersonalized suggestions|Generate a concise UI title)/i;
  const hasWork = llmEvents.length > 0 || toolEvents.length > 0 ||
    invokedSkills.length > 0 || subagentEvents.length > 0;
  const hasLifecycleExecution = rootEvents.some((event) =>
    attrs(event)['agent.insight.lifecycle'] === 'execution');
  const hasMeaningfulRootSignal = rootEvents.some((event) =>
    Boolean(eventInput(event) || eventOutput(event)));
  const internalOnlyRoot = rootEvents.some((event) => {
    const input = eventInput(event);
    return typeof input === 'string' && INTERNAL_ROOT_INPUT.test(input);
  });
  if (!hasWork && !hasLifecycleExecution && (!hasMeaningfulRootSignal || internalOnlyRoot)) {
    if (!traceThread?.events?.length) return null;
    return {
      task_id: `codex:${sourceThreadId}:thread-events`,
      framework: 'codex',
      label: 'codex-thread',
      user: first.user || 'anonymous',
      timestamp: traceThread.startedAt || new Date(),
      sourceThreadId,
      sourceKind,
      traceThread,
      threadOnly: true,
      interactions: [],
    };
  }
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
  const lifecycleStatus = ordered.map((event) => content(attrs(event)['codex.execution.status'])).find(Boolean);
  // 无生命周期信号时兜底推断（Bug 55）：桌面 OTLP-only 会话没有 Stop/rollout
  // 生命周期，executionStatus 为 NULL 让列表无法区分完成/执行中。证据规则：
  // 有 LLM usage/正文（模型已产出）→ completed；只有根输入无任何模型工作 →
  // running（等待模型或仅被窗口关闭打断时不虚报 completed）。
  const executionStatus = lifecycleStatus || (llmEvents.length > 0 ? 'completed' : undefined);

  return {
    task_id: sessionId,
    query,
    framework: 'codex',
    sourceThreadId,
    sourceExecutionId,
    traceThread,
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
    sourceKind,
    executionStatus,
    agents: Array.from(new Set([
      'codex',
      ...ordered
        .filter((event) => semanticKind(event) === 'subagent')
        .map((event) => agentName(event, displayNames)),
    ])),
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
