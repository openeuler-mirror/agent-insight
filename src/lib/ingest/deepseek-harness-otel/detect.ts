import { otelAttrsToObject } from '@/lib/ingest/claude-otel/otlp-json';

function resourceAttributes(resource: any): Record<string, any> {
  if (!resource || typeof resource !== 'object') return {};
  if (Array.isArray(resource.attributes)) return otelAttrsToObject(resource.attributes);
  if (resource.attributes && typeof resource.attributes === 'object') return resource.attributes;
  return {};
}

export function isDeepSeekHarnessResource(resource: any): boolean {
  const attributes = resourceAttributes(resource);
  return String(attributes['service.name'] || '').trim().toLowerCase() === 'deepseek-harness';
}

export type DeepSeekHarnessOtlpPartition = {
  harnessResourceCount: number;
  harnessBody: any;
  remainingBody: any;
  hasRemainingResources: boolean;
};

export function partitionDeepSeekHarnessOtlpLogs(body: any): DeepSeekHarnessOtlpPartition {
  const source = body && typeof body === 'object' ? body : {};
  const key = Array.isArray(source.resourceLogs)
    ? 'resourceLogs'
    : Array.isArray(source.resource_logs)
      ? 'resource_logs'
      : 'resourceLogs';
  const groups = Array.isArray(source[key]) ? source[key] : [];
  const harnessGroups = groups.filter((group: any) => isDeepSeekHarnessResource(group?.resource));
  const remainingGroups = groups.filter((group: any) => !isDeepSeekHarnessResource(group?.resource));

  return {
    harnessResourceCount: harnessGroups.length,
    harnessBody: { ...source, [key]: harnessGroups },
    remainingBody: { ...source, [key]: remainingGroups },
    hasRemainingResources: remainingGroups.length > 0,
  };
}
