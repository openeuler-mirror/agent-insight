import { getOtelTraceSpoolDir, visitEventsForSession } from './spool';
import { getOtelTraceAdapter } from './adapter-registry';
import type { OtelTraceAggregationResult, OtelTraceEvent } from './types';

const DEFAULT_MAX_UNIQUE_EVENTS = 50_000;
const DEFAULT_MAX_RETAINED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 16 * 1024 * 1024;

class OtelTraceAggregationLimitError extends Error {
  constructor(
    readonly limit: 'unique-events' | 'retained-bytes' | 'event-bytes',
    readonly actual: number,
    readonly maximum: number,
    readonly eventCount: number,
  ) {
    super(`OTel trace aggregation exceeded ${limit}: ${actual} > ${maximum}`);
    this.name = 'OtelTraceAggregationLimitError';
  }
}

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dedupeKey(event: OtelTraceEvent): string {
  return event.spanId || [event.sessionId, event.traceId || "", event.name || "", event.kind, event.startTimeMs || ""].join("|");
}

function isActrailEvent(event: OtelTraceEvent): boolean {
  return event.serviceName === 'actrail' ||
    event.attributes?.['actrail.action.kind'] !== undefined;
}

function snapshotEndMs(event: OtelTraceEvent): number {
  const explicitEnd = Number((event as OtelTraceEvent & { endTimeMs?: unknown }).endTimeMs);
  if (Number.isFinite(explicitEnd) && explicitEnd > 0) return explicitEnd;
  return (event.startTimeMs || 0) + Math.max(0, event.latencyMs || 0);
}

function isCodexEvent(event: OtelTraceEvent): boolean {
  return event.serviceName === 'codex'
    || event.serviceName === 'codex-cli'
    || event.framework === 'codex'
    || event.attributes?.['agent.insight.framework'] === 'codex';
}

function isTerminalSnapshot(event: OtelTraceEvent): boolean {
  const outcome = String(event.attributes?.['tool.outcome'] || '').toLowerCase();
  return outcome === 'success'
    || outcome === 'completed'
    || outcome === 'error'
    || outcome === 'failed';
}

function isSameQwenSkill(
  existing: OtelTraceEvent,
  candidate: OtelTraceEvent,
): boolean {
  return existing.serviceName === candidate.serviceName
    && ['qwencode', 'qwen-code'].includes(existing.serviceName)
    && new Set([existing.name, candidate.name]).has('qwen-code.skill')
    && new Set([existing.name, candidate.name]).has('qwen-code.tool');
}

export function shouldReplaceOtelSnapshot(
  existing: OtelTraceEvent,
  candidate: OtelTraceEvent,
): boolean {
  if (isCodexEvent(existing) || isCodexEvent(candidate)) {
    return snapshotEndMs(candidate) >= snapshotEndMs(existing);
  }
  // Qwen 会为同一次 Skill 产生 Log 摘要和完整 Tool span。
  // 始终保留包含真实耗时、参数和结果的 Tool span。
  if (isSameQwenSkill(existing, candidate)) {
    return candidate.name === 'qwen-code.tool';
  }

  const existingEnd = snapshotEndMs(existing);
  const candidateEnd = snapshotEndMs(candidate);
  if (candidateEnd !== existingEnd) return candidateEnd > existingEnd;

  const existingTerminal = isTerminalSnapshot(existing);
  const candidateTerminal = isTerminalSnapshot(candidate);
  if (candidateTerminal !== existingTerminal) return candidateTerminal;

  const existingOutput = String(
    existing.attributes?.['output.value']
      ?? existing.attributes?.['tool.result']
      ?? '',
  );
  const candidateOutput = String(
    candidate.attributes?.['output.value']
      ?? candidate.attributes?.['tool.result']
      ?? '',
  );
  if (Boolean(candidateOutput) !== Boolean(existingOutput)) {
    return Boolean(candidateOutput);
  }

  return Date.parse(candidate.receivedAt || '')
    >= Date.parse(existing.receivedAt || '');
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
    if (!existing || shouldReplaceOtelSnapshot(existing, event)) selected.set(key, event);
  }
  const retained = Array.from(selected.values());
  const sorted = retained.sort((a, b) => (a.startTimeMs || 0) - (b.startTimeMs || 0));
  if (!sorted.length) return null;
  // Keep a foreign framework's raw spool for the server that owns its adapter.
  return adapter.aggregate(sessionId, sorted) || null;
}

export function aggregateOtelTraceSession(
  sessionId: string,
  spoolDir = getOtelTraceSpoolDir(),
): OtelTraceAggregationResult {
  const enforceGoalPlusLimits = sessionId.startsWith('goal-plus:');
  const selected = new Map<string, OtelTraceEvent>();
  const selectedBytes = new Map<string, number>();
  const maxUniqueEvents = positiveEnvNumber(
    'AGENT_INSIGHT_OTEL_AGG_MAX_UNIQUE_EVENTS',
    DEFAULT_MAX_UNIQUE_EVENTS,
  );
  const maxRetainedBytes = positiveEnvNumber(
    'AGENT_INSIGHT_OTEL_AGG_MAX_RETAINED_BYTES',
    DEFAULT_MAX_RETAINED_BYTES,
  );
  const maxEventBytes = positiveEnvNumber(
    'AGENT_INSIGHT_OTEL_AGG_MAX_EVENT_BYTES',
    DEFAULT_MAX_EVENT_BYTES,
  );
  let retainedBytes = 0;
  let eventCount = 0;

  try {
    const visitResult = visitEventsForSession<OtelTraceEvent>(
      spoolDir,
      'traces.jsonl',
      sessionId,
      (event, lineBytes) => {
        eventCount += 1;
        const key = dedupeKey(event);
        const existing = selected.get(key);
        if (!event.spanId && existing && !isActrailEvent(event)) return;
        if (existing && !shouldReplaceOtelSnapshot(existing, event)) return;

        if (enforceGoalPlusLimits && !existing && selected.size >= maxUniqueEvents) {
          throw new OtelTraceAggregationLimitError(
            'unique-events',
            selected.size + 1,
            maxUniqueEvents,
            eventCount,
          );
        }
        const nextRetainedBytes = retainedBytes - (selectedBytes.get(key) || 0) + lineBytes;
        if (enforceGoalPlusLimits && nextRetainedBytes > maxRetainedBytes) {
          throw new OtelTraceAggregationLimitError(
            'retained-bytes',
            nextRetainedBytes,
            maxRetainedBytes,
            eventCount,
          );
        }
        selected.set(key, event);
        selectedBytes.set(key, lineBytes);
        retainedBytes = nextRetainedBytes;
      },
      enforceGoalPlusLimits ? {
        maxLineBytes: maxEventBytes,
        onOversizedLine: (lineBytes) => {
          throw new OtelTraceAggregationLimitError(
            'event-bytes',
            lineBytes,
            maxEventBytes,
            eventCount,
          );
        },
      } : {},
    );
    eventCount = visitResult.eventCount;
  } catch (error) {
    if (!(error instanceof OtelTraceAggregationLimitError)) throw error;
    console.warn('[OTel] Discarding oversized trace session', {
      sessionId,
      limit: error.limit,
      actual: error.actual,
      maximum: error.maximum,
      eventCount: error.eventCount,
    });
    return {
      sessionId,
      eventCount: error.eventCount,
      record: null,
      disposition: 'discard',
      reason: 'aggregation-limit',
    };
  }

  const retained = Array.from(selected.values());
  if (eventCount >= 1_000 && eventCount > retained.length * 2) {
    console.info('[OTel] Stream-deduplicated trace session', {
      sessionId,
      scannedEvents: eventCount,
      uniqueEvents: retained.length,
      duplicateEvents: eventCount - retained.length,
      retainedBytes,
    });
  }
  const record = aggregateOtelTraceEvents(sessionId, retained);
  return record
    ? { sessionId, eventCount, record, disposition: 'persisted' }
    : { sessionId, eventCount, record: null, disposition: 'retry-later' };
}
