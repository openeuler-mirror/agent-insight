import { genericOtelTraceAdapter } from './adapters/generic';
import { openclawOtelTraceAdapter } from './adapters/openclaw';
import { hermesOtelTraceAdapter } from './adapters/hermes';
import { langfuseLangGraphOtelTraceAdapter } from './adapters/langfuse-langgraph';
import { qoderOtelTraceAdapter } from './adapters/qoder';
import { qwenCodeOtelTraceAdapter } from './adapters/qwencode';
import type { OtelTraceAdapter } from './adapters/types';
import type { OtelTraceEvent } from './types';

const adapters: readonly OtelTraceAdapter[] = [
  langfuseLangGraphOtelTraceAdapter,
  hermesOtelTraceAdapter,
  qwenCodeOtelTraceAdapter,
  openclawOtelTraceAdapter,
  qoderOtelTraceAdapter,
  genericOtelTraceAdapter,
];

export function getOtelTraceAdapter(events: OtelTraceEvent[]): OtelTraceAdapter {
  return adapters.find((adapter) => adapter.matches(events)) || genericOtelTraceAdapter;
}

export function listOtelTraceAdapters(): readonly OtelTraceAdapter[] {
  return adapters;
}
