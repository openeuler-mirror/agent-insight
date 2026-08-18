import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';

export interface OtelTraceAdapter {
  readonly id: string;
  matches(events: OtelTraceEvent[]): boolean;
  /**
   * Runs after this adapter is selected and before the shared start-time sort.
   * Use it only when the adapter requires a different snapshot/deduplication
   * policy; adapters without this hook keep the shared first-span policy.
   */
  preprocessEvents?(events: OtelTraceEvent[]): OtelTraceEvent[];
  aggregate(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null;
}
