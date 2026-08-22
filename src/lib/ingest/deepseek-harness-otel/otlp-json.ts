import { getOtelAnyValue, otelAttrsToObject } from '@/lib/ingest/claude-otel/otlp-json';
import type { DeepSeekHarnessOtelEvent } from './types';

function text(value: any): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function number(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function timestampFromNano(value: any): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  try {
    const milliseconds = Number(BigInt(String(value)) / BigInt(1_000_000));
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  } catch {
    return undefined;
  }
}

function scopeLogsOf(resourceLog: any): any[] {
  if (Array.isArray(resourceLog?.scopeLogs)) return resourceLog.scopeLogs;
  if (Array.isArray(resourceLog?.scope_logs)) return resourceLog.scope_logs;
  return [];
}

function recordsOf(scopeLog: any): any[] {
  if (Array.isArray(scopeLog?.logRecords)) return scopeLog.logRecords;
  if (Array.isArray(scopeLog?.log_records)) return scopeLog.log_records;
  return [];
}

export function normalizeDeepSeekHarnessOtlpLogs(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): DeepSeekHarnessOtelEvent[] {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const authenticatedUser = text(opts.authenticatedUser);
  if (!authenticatedUser) return [];
  const resourceLogs = Array.isArray(body?.resourceLogs)
    ? body.resourceLogs
    : Array.isArray(body?.resource_logs)
      ? body.resource_logs
      : [];
  const events: DeepSeekHarnessOtelEvent[] = [];

  for (const resourceLog of resourceLogs) {
    const resource = otelAttrsToObject(resourceLog?.resource?.attributes || []);
    for (const scopeLog of scopeLogsOf(resourceLog)) {
      const scope = {
        name: text(scopeLog?.scope?.name),
        version: text(scopeLog?.scope?.version),
      };
      for (const logRecord of recordsOf(scopeLog)) {
        const attributes = otelAttrsToObject(logRecord?.attributes || []);
        const sessionId = text(attributes['session.id']);
        const eventType = text(attributes['event.type']) || text(attributes['telemetry.op']);
        if (!sessionId || !eventType) continue;
        events.push({
          receivedAt,
          eventTimestamp: timestampFromNano(logRecord?.timeUnixNano ?? logRecord?.time_unix_nano)
            || timestampFromNano(logRecord?.observedTimeUnixNano ?? logRecord?.observed_time_unix_nano)
            || text(attributes['event.timestamp'])
            || receivedAt,
          sessionId,
          sourceSessionId: sessionId,
          eventType,
          sequence: number(attributes['event.seq']),
          user: authenticatedUser,
          resource,
          attributes,
          scope,
          body: getOtelAnyValue(logRecord?.body),
        });
      }
    }
  }

  return events;
}
