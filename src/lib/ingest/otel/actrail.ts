import { otelAttrsToObject } from '@/lib/ingest/claude-otel/otlp-json';
import type { OtelTraceEvent } from './types';

const ACTRAIL_SCOPE = 'actrail.semantic_actions';

function asString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function asNumber(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function nanoToBigInt(value: unknown): bigint {
  try {
    return BigInt(String(value ?? 0));
  } catch {
    return BigInt(0);
  }
}

function isActrailResourceSpan(resourceSpan: any): boolean {
  const resource = otelAttrsToObject(resourceSpan?.resource?.attributes || []);
  if (resource['actrail.trace.id'] !== undefined) return true;

  for (const scopeSpan of Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : []) {
    if (asString(scopeSpan?.scope?.name)?.startsWith('actrail.')) return true;
    for (const span of Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : []) {
      const attributes = otelAttrsToObject(span?.attributes || []);
      if (attributes['actrail.action.kind'] !== undefined) return true;
    }
  }

  return false;
}

export function isActrailOtlpTraceBody(body: any): boolean {
  return (Array.isArray(body?.resourceSpans) ? body.resourceSpans : []).some(isActrailResourceSpan);
}

function eventKind(actionKind: string | undefined): OtelTraceEvent['kind'] {
  return actionKind?.startsWith('llm.') ? 'llm' : 'span';
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'string') return undefined;
  const wanted = name.toLowerCase();
  for (const line of headers.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    if (line.slice(0, separator).trim().toLowerCase() !== wanted) continue;
    return asString(line.slice(separator + 1));
  }
  return undefined;
}

export function normalizeActrailOtlpTraces(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): OtelTraceEvent[] {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const events: OtelTraceEvent[] = [];

  for (const resourceSpan of Array.isArray(body?.resourceSpans) ? body.resourceSpans : []) {
    if (!isActrailResourceSpan(resourceSpan)) continue;

    const resource = otelAttrsToObject(resourceSpan?.resource?.attributes || []);
    for (const scopeSpan of Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : []) {
      const scopeName = asString(scopeSpan?.scope?.name);
      const scopeVersion = asString(scopeSpan?.scope?.version);

      for (const span of Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : []) {
        const spanAttributes = otelAttrsToObject(span?.attributes || []);
        const actionKind = asString(spanAttributes['actrail.action.kind']);
        if (!actionKind && scopeName !== ACTRAIL_SCOPE) continue;

        const traceId = asString(span?.traceId);
        const sessionId = traceId || asString(resource['actrail.trace.id']);
        if (!sessionId) continue;

        const startNano = nanoToBigInt(span?.startTimeUnixNano);
        const endNano = nanoToBigInt(span?.endTimeUnixNano);
        const inputTokens = actionKind === 'llm.response'
          ? asNumber(spanAttributes['llm.response.prompt_tokens'])
          : 0;
        const outputTokens = actionKind === 'llm.response'
          ? asNumber(spanAttributes['llm.response.completion_tokens'])
          : 0;
        const reasoningTokens = actionKind === 'llm.response'
          ? asNumber(spanAttributes['llm.response.reasoning_tokens'])
          : 0;
        const explicitTotal = actionKind === 'llm.response'
          ? asNumber(spanAttributes['llm.response.total_tokens'])
          : 0;
        const agentSessionId = actionKind === 'llm.request'
          ? headerValue(spanAttributes['http.request.headers_text'], 'x-session-id')
          : undefined;

        events.push({
          receivedAt,
          sessionId,
          traceId,
          spanId: asString(span?.spanId),
          parentSpanId: asString(span?.parentSpanId),
          name: asString(span?.name),
          kind: eventKind(actionKind),
          serviceName: 'actrail',
          user: opts.authenticatedUser,
          model: asString(
            spanAttributes['llm.call.model'] ||
            spanAttributes['llm.request.model'] ||
            spanAttributes['llm.response.model'],
          ),
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            reasoning_tokens: reasoningTokens || undefined,
            total_tokens: explicitTotal || inputTokens + outputTokens,
          },
          latencyMs: endNano > startNano
            ? Number((endNano - startNano) / BigInt(1_000_000))
            : 0,
          startTimeMs: Number(startNano / BigInt(1_000_000)),
          attributes: {
            ...spanAttributes,
            'actrail.trace.display_name': resource['actrail.trace.display_name'],
            'actrail.trace.profile_name': resource['actrail.trace.profile_name'],
            'actrail.trace.id': resource['actrail.trace.id'],
            'actrail.resource.service_name': resource['service.name'],
            'actrail.agent.session_id': agentSessionId,
            'otel.scope.name': scopeName,
            'otel.scope.version': scopeVersion,
            'otel.status.code': asString(span?.status?.code),
            'otel.status.message': asString(span?.status?.message),
          },
        });
      }
    }
  }

  return events;
}
