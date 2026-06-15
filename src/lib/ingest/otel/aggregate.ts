import { readOtelTraceEventsForSession } from './spool';
import { getOtelTraceAdapter } from './adapter-registry';
import type { OtelTraceAggregationResult, OtelTraceEvent } from './types';

function dedupeKey(event: OtelTraceEvent): string {
  return event.spanId || [event.sessionId, event.traceId || '', event.name || '', event.kind, event.startTimeMs || ''].join('|');
}

export function aggregateOtelTraceEvents(sessionId: string, events: OtelTraceEvent[]) {
  const seen = new Set<string>();
  const ordered = events
    .filter((event) => event.sessionId === sessionId)
    .filter((event) => {
      const key = dedupeKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  if (!ordered.length) return null;
  return getOtelTraceAdapter(ordered).aggregate(sessionId, ordered);
}

export function aggregateOtelTraceSession(sessionId: string, spoolDir?: string): OtelTraceAggregationResult {
  const events = readOtelTraceEventsForSession(sessionId, spoolDir);
  return { sessionId, eventCount: events.length, record: aggregateOtelTraceEvents(sessionId, events) };
}
