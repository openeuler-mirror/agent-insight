import { otelAttrsToObject } from '@/lib/ingest/claude-otel/otlp-json';
import type { OtelTraceEvent } from './types';

export const LANGFUSE_LANGGRAPH_FRAMEWORK = 'langfuse-langgraph';

type NormalizeOpts = {
  receivedAt?: string;
  authenticatedUser?: string;
};

function asString(value: any): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

function firstString(...values: any[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return undefined;
}

function asNumber(value: any, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonObject(value: any): Record<string, any> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nanoToBigInt(value: any): bigint {
  if (value === undefined || value === null || value === '') return BigInt(0);
  try {
    return BigInt(String(value));
  } catch {
    return BigInt(0);
  }
}

function langfuseKind(type: string | undefined): OtelTraceEvent['kind'] {
  switch ((type || '').toLowerCase()) {
    case 'generation':
      return 'llm';
    case 'tool':
      return 'tool';
    case 'agent':
      return 'agent';
    case 'chain':
      return 'chain';
    case 'span':
      return 'span';
    default:
      return 'chain';
  }
}

function usageFromLangfuse(attrs: Record<string, any>) {
  const usage = parseJsonObject(attrs['langfuse.observation.usage_details']);
  const inputTokens = asNumber(usage.input ?? usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = asNumber(usage.output ?? usage.output_tokens ?? usage.completion_tokens);
  const reasoningTokens = asNumber(usage.output_reasoning ?? usage.reasoning ?? usage.reasoning_tokens);
  const total = asNumber(usage.total ?? usage.total_tokens, inputTokens + outputTokens + reasoningTokens);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    reasoning_tokens: reasoningTokens || undefined,
    total_tokens: total,
  };
}

export function isLangfuseOtlpTraceBody(body: any): boolean {
  for (const resourceSpan of Array.isArray(body?.resourceSpans) ? body.resourceSpans : []) {
    for (const scopeSpan of Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : []) {
      for (const span of Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : []) {
        const attrs = otelAttrsToObject(span?.attributes || []);
        if (attrs['langfuse.observation.type'] || attrs['langfuse.internal.is_app_root']) return true;
      }
    }
  }
  return false;
}

export function normalizeLangfuseOtlpTraces(
  body: any,
  opts: NormalizeOpts = {},
): OtelTraceEvent[] {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const events: OtelTraceEvent[] = [];
  const resourceSpans = Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];

  for (const resourceSpan of resourceSpans) {
    const resource = otelAttrsToObject(resourceSpan?.resource?.attributes || []);
    const resourceSessionId = firstString(
      resource['session.id'],
      resource['service.instance.id'],
    );
    const resourceUser = firstString(resource['user.id'], resource['enduser.id']);
    const scopeSpans = Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : [];

    for (const scopeSpan of scopeSpans) {
      const spans = Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : [];
      for (const span of spans) {
        try {
          const attributes = otelAttrsToObject(span?.attributes || []);
          if (!attributes['langfuse.observation.type'] && !attributes['langfuse.internal.is_app_root']) continue;

          const traceId = asString(span?.traceId);
          const langfuseSessionId = firstString(
            attributes['langfuse.observation.metadata.session_id'],
            attributes['langfuse.trace.metadata.session_id'],
            attributes['langfuse.session.id'],
            attributes['session.id'],
            resourceSessionId,
          );
          const sessionId = traceId || langfuseSessionId;
          if (!sessionId) continue;
          if (langfuseSessionId && !attributes['langfuse.internal.session_id']) {
            attributes['langfuse.internal.session_id'] = langfuseSessionId;
          }

          const startTimeNano = nanoToBigInt(span?.startTimeUnixNano);
          const endTimeNano = nanoToBigInt(span?.endTimeUnixNano);
          const latencyMs = endTimeNano > startTimeNano
            ? Number((endTimeNano - startTimeNano) / BigInt(1_000_000))
            : 0;
          const startTimeMs = Number(startTimeNano / BigInt(1_000_000));
          const integration = firstString(
            attributes['langfuse.trace.metadata.ls_integration'],
            attributes['langfuse.observation.metadata.ls_integration'],
          );
          const serviceName = integration === 'langgraph'
            ? LANGFUSE_LANGGRAPH_FRAMEWORK
            : 'langfuse';

          events.push({
            receivedAt,
            sessionId,
            traceId,
            spanId: asString(span?.spanId),
            parentSpanId: asString(span?.parentSpanId),
            name: asString(span?.name),
            kind: langfuseKind(asString(attributes['langfuse.observation.type'])),
            serviceName,
            user: opts.authenticatedUser ||
              firstString(
                attributes['langfuse.observation.metadata.user_id'],
                attributes['langfuse.trace.metadata.user_id'],
                attributes['langfuse.user.id'],
                resourceUser,
              ),
            model: firstString(
              attributes['langfuse.observation.model.name'],
              attributes['langfuse.observation.metadata.model'],
              attributes['langfuse.trace.metadata.model'],
            ),
            usage: usageFromLangfuse(attributes),
            latencyMs,
            startTimeMs,
            attributes,
          });
        } catch (err) {
          console.warn('[Langfuse] Failed to normalize span', {
            traceId: asString(span?.traceId),
            spanId: asString(span?.spanId),
            name: asString(span?.name),
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return events;
}
