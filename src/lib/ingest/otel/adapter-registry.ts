import { genericOtelTraceAdapter } from './adapters/generic';
import { hermesOtelTraceAdapter } from './adapters/hermes';
import type { OtelTraceAdapter } from './adapters/types';
import type { OtelTraceEvent } from './types';

const adapters: readonly OtelTraceAdapter[] = [hermesOtelTraceAdapter, genericOtelTraceAdapter];

export function getOtelTraceAdapter(events: OtelTraceEvent[]): OtelTraceAdapter {
  return adapters.find((adapter) => adapter.matches(events)) || genericOtelTraceAdapter;
}

export function listOtelTraceAdapters(): readonly OtelTraceAdapter[] {
  return adapters;
}
