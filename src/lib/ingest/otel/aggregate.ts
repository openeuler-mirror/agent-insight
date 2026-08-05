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

function dedupeEvents(events: OtelTraceEvent[]): OtelTraceEvent[] {
  if (!events.some(isActrailEvent)) {
    const seen = new Set<string>();
    return events.filter((event) => {
      const key = dedupeKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  const latestByKey = new Map<string, OtelTraceEvent>();
  for (const event of events) {
    latestByKey.set(dedupeKey(event), event);
  }
  return [...latestByKey.values()];
}

export function aggregateOtelTraceEvents(sessionId: string, events: OtelTraceEvent[]) {
  const ordered = dedupeEvents(events.filter((event) => event.sessionId === sessionId))
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  if (!ordered.length) return null;
  const adapter = getOtelTraceAdapter(ordered);
  // Keep a foreign framework's raw spool for the server that owns its adapter.
  return adapter?.aggregate(sessionId, ordered) || null;
}

export function aggregateOtelTraceSession(sessionId: string, spoolDir?: string): OtelTraceAggregationResult {
  const events = readOtelTraceEventsForSession(sessionId, spoolDir);
  return { sessionId, eventCount: events.length, record: aggregateOtelTraceEvents(sessionId, events) };
}
