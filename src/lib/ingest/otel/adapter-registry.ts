import { actrailOtelTraceAdapter } from './adapters/actrail';
import { genericOtelTraceAdapter } from './adapters/generic';
import { openclawOtelTraceAdapter } from './adapters/openclaw';
import { hermesOtelTraceAdapter } from './adapters/hermes';
import { langfuseLangGraphOtelTraceAdapter } from './adapters/langfuse-langgraph';
import { llamaIndexOtelTraceAdapter } from './adapters/llamaindex';
import { piAgentOtelTraceAdapter } from './adapters/pi-agent';
import { qoderOtelTraceAdapter } from './adapters/qoder';
import type { OtelTraceAdapter } from './adapters/types';
import type { OtelTraceEvent } from './types';

const adapters: readonly OtelTraceAdapter[] = [
  actrailOtelTraceAdapter,
  langfuseLangGraphOtelTraceAdapter,
  hermesOtelTraceAdapter,
  openclawOtelTraceAdapter,
  llamaIndexOtelTraceAdapter,
  qoderOtelTraceAdapter,
  piAgentOtelTraceAdapter,
  genericOtelTraceAdapter,
];

export function getOtelTraceAdapter(events: OtelTraceEvent[]): OtelTraceAdapter {
  return adapters.find((adapter) => adapter.matches(events)) || genericOtelTraceAdapter;
}

export function listOtelTraceAdapters(): readonly OtelTraceAdapter[] {
  return adapters;
}
