import { genericOtelTraceAdapter } from './adapters/generic';
import { actrailOtelTraceAdapter } from './adapters/actrail';
import { openclawOtelTraceAdapter } from './adapters/openclaw';
import { hermesOtelTraceAdapter } from './adapters/hermes';
import { langfuseLangGraphOtelTraceAdapter } from './adapters/langfuse-langgraph';
import { llamaIndexOtelTraceAdapter } from './adapters/llamaindex';
import { piAgentOtelTraceAdapter } from './adapters/pi-agent';
import { qoderOtelTraceAdapter } from './adapters/qoder';
import { codexOtelTraceAdapter } from './adapters/codex';
import { qwenCodeOtelTraceAdapter } from './adapters/qwencode';r
import type { OtelTraceAdapter } from './adapters/types';
import type { OtelTraceEvent } from './types';

const frameworkAdapters: readonly OtelTraceAdapter[] = [
  actrailOtelTraceAdapter,
  langfuseLangGraphOtelTraceAdapter,
  hermesOtelTraceAdapter,
  qwenCodeOtelTraceAdapter,
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

/**
 * Framework-specific collectors may emit their identity either in the OTLP
 * attribute or as a retained top-level field in canonical spool events. A
 * worktree that does not own that framework must leave the trace alone instead
 * of letting the generic fallback invent tool calls in the shared Session row.
 */
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
