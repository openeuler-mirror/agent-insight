import type { ExecutionRecord } from '@/lib/storage/data-service';
import type { OtelTraceEvent } from '../types';

export interface OtelTraceAdapter {
  readonly id: string;
  matches(events: OtelTraceEvent[]): boolean;
  preprocessEvents?(events: OtelTraceEvent[]): OtelTraceEvent[];
  aggregate(sessionId: string, events: OtelTraceEvent[]): ExecutionRecord | null;
}
