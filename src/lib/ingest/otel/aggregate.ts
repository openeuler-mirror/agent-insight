import { readOtelTraceEventsForSession } from './spool';
import { getOtelTraceAdapter } from './adapter-registry';
import type { OtelTraceAggregationResult, OtelTraceEvent } from './types';

function dedupeKey(event: OtelTraceEvent): string {
  return event.spanId || [event.sessionId, event.traceId || "", event.name || "", event.kind, event.startTimeMs || ""].join("|");
}

function isActrailEvent(event: OtelTraceEvent): boolean {
  return event.serviceName === 'actrail' ||
    event.attributes?.['actrail.action.kind'] !== undefined;
}

function snapshotEndMs(event: OtelTraceEvent): number {
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function isTerminalSnapshot(event: OtelTraceEvent): boolean {
  const outcome = String(event.attributes?.['tool.outcome'] || '').toLowerCase();
  return outcome === 'success' || outcome === 'completed' || outcome === 'error' || outcome === 'failed';
}

function shouldReplaceSnapshot(existing: OtelTraceEvent, candidate: OtelTraceEvent): boolean {
  const existingEnd = snapshotEndMs(existing);
  const candidateEnd = snapshotEndMs(candidate);
  if (candidateEnd !== existingEnd) return candidateEnd > existingEnd;

  const existingTerminal = isTerminalSnapshot(existing);
  const candidateTerminal = isTerminalSnapshot(candidate);
  if (candidateTerminal !== existingTerminal) return candidateTerminal;

  const existingOutput = String(existing.attributes?.['output.value'] ?? existing.attributes?.['tool.result'] ?? '');
  const candidateOutput = String(candidate.attributes?.['output.value'] ?? candidate.attributes?.['tool.result'] ?? '');
  if (Boolean(candidateOutput) !== Boolean(existingOutput)) return Boolean(candidateOutput);

  return Date.parse(candidate.receivedAt || '') >= Date.parse(existing.receivedAt || '');
}

export function aggregateOtelTraceEvents(sessionId: string, events: OtelTraceEvent[]) {
  const sessionEvents = events.filter((event) => event.sessionId === sessionId);
  if (!sessionEvents.length) return null;
  const adapter = getOtelTraceAdapter(sessionEvents);
  if (!adapter) return null;
  const prepared = adapter.preprocessEvents
    ? adapter.preprocessEvents(sessionEvents)
    : sessionEvents;
  const selected = new Map<string, OtelTraceEvent>();
  for (const event of prepared) {
    const key = dedupeKey(event);
    const existing = selected.get(key);
    // AcTrail emits revised events for a span. Other span-less legacy events
    // retain their established first-event fallback behavior.
    if (!event.spanId && existing && !isActrailEvent(event)) continue;
    if (!existing || shouldReplaceSnapshot(existing, event)) selected.set(key, event);
  }
  const retained = Array.from(selected.values());
  const sorted = retained.sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  if (!sorted.length) return null;
  // Keep a foreign framework's raw spool for the server that owns its adapter.
  return adapter.aggregate(sessionId, sorted) || null;
}

export function aggregateOtelTraceSession(sessionId: string, spoolDir?: string): OtelTraceAggregationResult {
  const events = readOtelTraceEventsForSession(sessionId, spoolDir);
  const record = aggregateOtelTraceEvents(sessionId, events);
  return record
    ? { sessionId, eventCount: events.length, record, disposition: 'persisted' }
    : { sessionId, eventCount: events.length, record: null, disposition: 'retry-later' };
}
