import { readOtelTraceEventsForSession } from './spool';
import { getOtelTraceAdapter } from './adapter-registry';
import type { OtelTraceAggregationResult, OtelTraceEvent } from './types';

function dedupeKey(event: OtelTraceEvent): string {
  return event.spanId || [event.sessionId, event.traceId || "", event.name || "", event.kind, event.startTimeMs || ""].join("|");
}

function isActrailEvent(event: OtelTraceEvent): boolean {
  return event.serviceName === "actrail" ||
    event.attributes?.["actrail.action.kind"] !== undefined;
}

function preferredDuplicate(existing: OtelTraceEvent, incoming: OtelTraceEvent): OtelTraceEvent {
  const sameQwenSkill = existing.serviceName === incoming.serviceName
    && ['qwencode', 'qwen-code'].includes(existing.serviceName)
    && new Set([existing.name, incoming.name]).has('qwen-code.skill')
    && new Set([existing.name, incoming.name]).has('qwen-code.tool');
  if (!sameQwenSkill) {
    return isActrailEvent(existing) || isActrailEvent(incoming) ? incoming : existing;
  }

  // Qwen emits the same Skill invocation twice with the same spanId: a
  // skill_launch Log (0ms, summary only) and the native Tool span (real timing,
  // full arguments/result). Always retain the richer Tool span regardless of
  // which OTLP signal arrived first.
  return incoming.name === 'qwen-code.tool' ? incoming : existing;
}

function dedupeEvents(events: OtelTraceEvent[]): OtelTraceEvent[] {
  const unique = new Map<string, OtelTraceEvent>();
  for (const event of events) {
    const key = dedupeKey(event);
    const existing = unique.get(key);
    unique.set(key, existing ? preferredDuplicate(existing, event) : event);
  }
  return [...unique.values()];
}

export function aggregateOtelTraceEvents(sessionId: string, events: OtelTraceEvent[]) {
  const ordered = dedupeEvents(events.filter((event) => event.sessionId === sessionId))
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  if (!ordered.length) return null;
  return getOtelTraceAdapter(ordered).aggregate(sessionId, ordered);
}

export function aggregateOtelTraceSession(sessionId: string, spoolDir?: string): OtelTraceAggregationResult {
  const events = readOtelTraceEventsForSession(sessionId, spoolDir);
  return { sessionId, eventCount: events.length, record: aggregateOtelTraceEvents(sessionId, events) };
}
