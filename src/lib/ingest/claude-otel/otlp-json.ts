import type { ClaudeOtelEvent } from './types';

export function getOtelAnyValue(anyValue: any): any {
  if (!anyValue || typeof anyValue !== 'object') return undefined;
  if (anyValue.stringValue !== undefined) return anyValue.stringValue;
  if (anyValue.intValue !== undefined) return Number(anyValue.intValue);
  if (anyValue.doubleValue !== undefined) return Number(anyValue.doubleValue);
  if (anyValue.boolValue !== undefined) return Boolean(anyValue.boolValue);
  if (anyValue.arrayValue !== undefined) {
    const values = anyValue.arrayValue?.values || [];
    return Array.isArray(values) ? values.map((v: any) => getOtelAnyValue(v)) : [];
  }
  if (anyValue.kvlistValue !== undefined) {
    const out: Record<string, any> = {};
    const values = anyValue.kvlistValue?.values || [];
    if (Array.isArray(values)) {
      for (const kv of values) {
        if (!kv?.key) continue;
        out[kv.key] = getOtelAnyValue(kv.value);
      }
    }
    return out;
  }
  return undefined;
}

export function otelAttrsToObject(attrs: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!Array.isArray(attrs)) return out;
  for (const attr of attrs) {
    if (!attr?.key) continue;
    out[attr.key] = getOtelAnyValue(attr.value);
  }
  return out;
}

function parseLogBody(body: any): any {
  const value = getOtelAnyValue(body);
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s) return value;
  if (!s.startsWith('{') && !s.startsWith('[')) return value;
  try {
    return JSON.parse(s);
  } catch {
    return value;
  }
}

function normalizeEventName(raw: any, body: any): string {
  const eventName = typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  if (eventName) return eventName.replace(/^claude_code\./, '');
  if (typeof body === 'string') return body.replace(/^claude_code\./, '');
  return 'unknown';
}

function asOptionalString(value: any): string | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  return s ? s : undefined;
}

function asOptionalNumber(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function normalizeClaudeOtlpLogs(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): ClaudeOtelEvent[] {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const events: ClaudeOtelEvent[] = [];
  const resourceLogs = Array.isArray(body?.resourceLogs) ? body.resourceLogs : [];

  for (const resourceLog of resourceLogs) {
    const resource = otelAttrsToObject(resourceLog?.resource?.attributes || []);
    const scopeLogs = Array.isArray(resourceLog?.scopeLogs) ? resourceLog.scopeLogs : [];

    for (const scopeLog of scopeLogs) {
      const logRecords = Array.isArray(scopeLog?.logRecords) ? scopeLog.logRecords : [];
      for (const logRecord of logRecords) {
        const attributes = otelAttrsToObject(logRecord?.attributes || []);
        const parsedBody = parseLogBody(logRecord?.body);
        const eventName = normalizeEventName(attributes['event.name'], parsedBody);
        const sessionId = asOptionalString(attributes['session.id']) ||
          asOptionalString(resource['session.id']) ||
          asOptionalString(resource['service.instance.id']);
        if (!sessionId) continue;

        events.push({
          receivedAt,
          eventName,
          eventTimestamp: asOptionalString(attributes['event.timestamp']),
          sequence: asOptionalNumber(attributes['event.sequence']),
          sessionId,
          promptId: asOptionalString(attributes['prompt.id']),
          user: opts.authenticatedUser ||
            asOptionalString(attributes['user.email']) ||
            asOptionalString(resource['user.email']) ||
            asOptionalString(attributes['user.id']) ||
            asOptionalString(resource['user.id']),
          resource,
          attributes,
          body: parsedBody,
          traceId: asOptionalString(logRecord?.traceId),
          spanId: asOptionalString(logRecord?.spanId),
        });
      }
    }
  }

  return events;
}

