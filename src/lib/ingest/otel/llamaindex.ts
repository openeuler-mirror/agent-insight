/* eslint-disable @typescript-eslint/no-explicit-any */
import { otelAttrsToObject } from '@/lib/ingest/claude-otel/otlp-json';
import { isServiceTraceOwner } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from './types';

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nano(value: unknown): bigint {
  try {
    return BigInt(String(value || 0));
  } catch {
    return BigInt(0);
  }
}

function resources(body: any): any[] {
  return Array.isArray(body?.resourceSpans) ? body.resourceSpans : [];
}

export function isLlamaIndexOtlpTraceBody(body: any): boolean {
  return resources(body).some((resourceSpan) => {
    const resource = otelAttrsToObject(resourceSpan?.resource?.attributes || []);
    if (resource['service.name'] === 'llamaindex' || resource['agent.insight.framework'] === 'llamaindex') {
      return true;
    }
    return (resourceSpan?.scopeSpans || []).some((scopeSpan: any) =>
      scopeSpan?.scope?.name === 'agent-insight-llamaindex' ||
      (scopeSpan?.spans || []).some((span: any) => {
        const attributes = otelAttrsToObject(span?.attributes || []);
        return attributes['agent.insight.framework'] === 'llamaindex';
      })
    );
  });
}

function eventKind(value: unknown): OtelTraceEvent['kind'] {
  switch (String(value || '').toLowerCase()) {
    case 'agent': return 'agent';
    case 'llm': return 'llm';
    case 'tool': return 'tool';
    case 'retriever':
    case 'synthesizer':
    case 'workflow':
    case 'workflow_step':
    case 'chain': return 'chain';
    default: return 'span';
  }
}

export function normalizeLlamaIndexOtlpTraces(
  body: any,
  opts: { receivedAt?: string; authenticatedUser?: string } = {},
): OtelTraceEvent[] {
  const receivedAt = opts.receivedAt || new Date().toISOString();
  const events: OtelTraceEvent[] = [];
  for (const resourceSpan of resources(body)) {
    const resource = otelAttrsToObject(resourceSpan?.resource?.attributes || []);
    const serviceName = text(resource['service.name']) || 'llamaindex';
    const authenticatedUser = text(opts.authenticatedUser);
    const declaredUser = text(resource['user.id']) || text(resource['enduser.id']);
    // A real authenticated user always wins, so a client cannot spoof another owner.
    // Service credentials (for example the local admin setup key) may carry traces
    // for the process owner declared by the collector.
    const resourceUser = authenticatedUser && !isServiceTraceOwner(authenticatedUser)
      ? authenticatedUser
      : declaredUser || authenticatedUser;
    for (const scopeSpan of resourceSpan?.scopeSpans || []) {
      for (const span of scopeSpan?.spans || []) {
        const attributes = otelAttrsToObject(span?.attributes || []);
        if (attributes['agent.insight.framework'] !== 'llamaindex' && serviceName !== 'llamaindex') continue;
        const traceId = text(span?.traceId);
        const sessionId = text(attributes['session.id']) || traceId;
        if (!sessionId) continue;
        const start = nano(span?.startTimeUnixNano);
        const end = nano(span?.endTimeUnixNano);
        const inputTokens = number(attributes['gen_ai.usage.input_tokens']);
        const outputTokens = number(attributes['gen_ai.usage.output_tokens']);
        const totalTokens = number(attributes['gen_ai.usage.total_tokens']) || inputTokens + outputTokens;
        const statusCode = number(span?.status?.code);
        attributes['agent.insight.status'] = statusCode === 2 ? 'error' : 'success';
        if (span?.status?.message) attributes['agent.insight.status_message'] = span.status.message;
        events.push({
          receivedAt,
          sessionId,
          traceId,
          spanId: text(span?.spanId),
          parentSpanId: text(span?.parentSpanId),
          name: text(span?.name),
          kind: eventKind(attributes['agent.insight.span.kind']),
          serviceName,
          user: resourceUser,
          model: text(attributes['gen_ai.request.model']) || text(attributes['gen_ai.response.model']),
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: totalTokens,
          },
          latencyMs: end > start ? Number((end - start) / BigInt(1_000_000)) : 0,
          startTimeMs: Number(start / BigInt(1_000_000)),
          attributes,
        });
      }
    }
  }
  return events;
}
