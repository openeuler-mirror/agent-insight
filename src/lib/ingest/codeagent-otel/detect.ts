import { otelAttrsToObject } from '@/lib/ingest/claude-otel/otlp-json';
import type { ClaudeOtelEvent } from '@/lib/ingest/claude-otel/types';

export type OtlpSignal = 'logs' | 'traces' | 'metrics';

const RESOURCE_KEYS: Record<OtlpSignal, readonly string[]> = {
  logs: ['resourceLogs', 'resource_logs'],
  traces: ['resourceSpans', 'resource_spans'],
  metrics: ['resourceMetrics', 'resource_metrics'],
};

export type CodeAgentOtlpPartition = {
  codeAgentResourceCount: number;
  remainingBody: any;
  hasRemainingResources: boolean;
};

function resourceAttributes(resource: any): Record<string, any> {
  if (!resource || typeof resource !== 'object') return {};
  if (Array.isArray(resource.attributes)) return otelAttrsToObject(resource.attributes);
  if (resource.attributes && typeof resource.attributes === 'object') return resource.attributes;
  return {};
}

export function isCodeAgentResource(resource: any): boolean {
  const attributes = resourceAttributes(resource);
  return String(attributes['service.name'] || '').trim().toLowerCase() === 'codeagentoc';
}

export function isCodeAgentOtelEvent(event: Pick<ClaudeOtelEvent, 'resource'>): boolean {
  return String(event?.resource?.['service.name'] || '').trim().toLowerCase() === 'codeagentoc';
}

export function partitionCodeAgentOtlpPayload(body: any, signal: OtlpSignal): CodeAgentOtlpPartition {
  const source = body && typeof body === 'object' ? body : {};
  const key = RESOURCE_KEYS[signal].find((candidate) => Array.isArray(source[candidate])) || RESOURCE_KEYS[signal][0];
  const groups = Array.isArray(source[key]) ? source[key] : [];
  const remaining = groups.filter((group: any) => !isCodeAgentResource(group?.resource));
  const codeAgentResourceCount = groups.length - remaining.length;

  return {
    codeAgentResourceCount,
    remainingBody: codeAgentResourceCount > 0 ? { ...source, [key]: remaining } : source,
    hasRemainingResources: remaining.length > 0,
  };
}
