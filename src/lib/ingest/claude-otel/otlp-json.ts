import type { ClaudeOtelEvent, OtelTraceEvent } from './types';

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

function asNumber(value: any, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function nanoToBigInt(value: any): bigint {
  if (value === undefined || value === null || value === '') return BigInt(0);
  try {
    return BigInt(String(value));
  } catch {
    return BigInt(0);
  }
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

export function normalizeClaudeOtlpTraces(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): OtelTraceEvent[] {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const events: OtelTraceEvent[] = [];
  const resourceSpans = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];

  for (const resourceSpan of resourceSpans) {
    const resource = otelAttrsToObject(resourceSpan?.resource?.attributes || []);
    const serviceName = asOptionalString(resource['service.name']) || 'unknown-service';
    const resourceUser = opts.authenticatedUser ||
      asOptionalString(resource['user.id']) ||
      asOptionalString(resource['enduser.id']);
    const serviceInstanceId = asOptionalString(resource['service.instance.id']);
    const resourceSessionId = asOptionalString(resource['session.id']);
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : [];

    for (const scopeSpan of scopeSpans) {
      const spans = Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : [];
      for (const span of spans) {
        try {
          const attributes = otelAttrsToObject(span?.attributes || []);
          const isGenAI = Object.keys(attributes).some((key) => key.startsWith('gen_ai.') || key.startsWith('llm.'));
          const isTool = attributes['tool.name'] !== undefined;
          if (!isGenAI && !isTool) continue;

          const traceId = asOptionalString(span?.traceId);
          const explicitSessionId = resourceSessionId || asOptionalString(attributes['session.id']);
          let sessionId = explicitSessionId || serviceInstanceId || traceId;
          if (sessionId === 'unknown' && traceId) sessionId = traceId;
          if (!sessionId) continue;

          const inputTokens = asNumber(attributes['gen_ai.usage.input_tokens'] ?? attributes['llm.usage.prompt_tokens']);
          const outputTokens = asNumber(attributes['gen_ai.usage.output_tokens'] ?? attributes['llm.usage.completion_tokens']);
          const reasoningTokens = asNumber(attributes['gen_ai.usage.reasoning_tokens']);
          const startTimeNano = nanoToBigInt(span?.startTimeUnixNano);
          const endTimeNano = nanoToBigInt(span?.endTimeUnixNano);
          const latencyMs = endTimeNano > startTimeNano
            ? Number((endTimeNano - startTimeNano) / BigInt(1_000_000))
            : 0;
          const startTimeMs = Number(startTimeNano / BigInt(1_000_000));

          events.push({
            receivedAt,
            sessionId,
            traceId,
            spanId: asOptionalString(span?.spanId),
            parentSpanId: asOptionalString(span?.parentSpanId),
            name: asOptionalString(span?.name),
            kind: isTool ? 'tool' : 'llm',
            serviceName,
            user: resourceUser,
            model: asOptionalString(attributes['gen_ai.request.model']) ||
              asOptionalString(attributes['llm.request.model']),
            usage: {
              input_tokens: inputTokens,
              output_tokens: outputTokens,
              reasoning_tokens: reasoningTokens || undefined,
              total_tokens: inputTokens + outputTokens,
            },
            latencyMs,
            startTimeMs,
            attributes,
          });
        } catch {}
      }
    }
  }

  return events;
}
