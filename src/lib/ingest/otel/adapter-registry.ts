import { actrailOtelTraceAdapter } from './adapters/actrail';
import { genericOtelTraceAdapter } from './adapters/generic';
import { openclawOtelTraceAdapter } from './adapters/openclaw';
import { hermesOtelTraceAdapter } from './adapters/hermes';
import { langfuseLangGraphOtelTraceAdapter } from './adapters/langfuse-langgraph';
import { llamaIndexOtelTraceAdapter } from './adapters/llamaindex';
import { piAgentOtelTraceAdapter } from './adapters/pi-agent';
import { qoderOtelTraceAdapter } from './adapters/qoder';
import { codexOtelTraceAdapter } from './adapters/codex';
import type { OtelTraceAdapter } from './adapters/types';
import type { OtelTraceEvent } from './types';

const frameworkAdapters: readonly OtelTraceAdapter[] = [
  actrailOtelTraceAdapter,
  langfuseLangGraphOtelTraceAdapter,
  hermesOtelTraceAdapter,
  openclawOtelTraceAdapter,
  codexOtelTraceAdapter,
  llamaIndexOtelTraceAdapter,
  qoderOtelTraceAdapter,
  piAgentOtelTraceAdapter,
];

const adapters: readonly OtelTraceAdapter[] = [
  ...frameworkAdapters,
  genericOtelTraceAdapter,
];

function claimsFrameworkSpecificOwnership(events: OtelTraceEvent[]): boolean {
  return events.some((event) => {
    const claims = [event.framework, event.attributes?.['agent.insight.framework']];
    return claims.some((claim) => typeof claim === 'string' && claim.trim().length > 0);
  });
}

export function getOtelTraceAdapter(events: OtelTraceEvent[]): OtelTraceAdapter | undefined {
  return frameworkAdapters.find((adapter) => adapter.matches(events)) ||
    (claimsFrameworkSpecificOwnership(events) ? undefined : genericOtelTraceAdapter);
}

export function listOtelTraceAdapters(): readonly OtelTraceAdapter[] {
  return adapters;
}
