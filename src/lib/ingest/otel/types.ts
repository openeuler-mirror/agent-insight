import type { ExecutionRecord } from '@/lib/storage/data-service';

export type OtelTraceEvent = {
  receivedAt: string;
  sessionId: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind: 'llm' | 'tool' | 'agent' | 'chain' | 'span';
  serviceName: string;
  user?: string;
  /** True only when the server resolved `user` from a valid ingest credential. */
  authenticatedUser?: boolean;
  model?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    reasoning_tokens?: number;
    total_tokens: number;
  };
  latencyMs: number;
  startTimeMs: number;
  attributes: Record<string, any>;
};

export type OtelTraceAppendResult = {
  events: OtelTraceEvent[];
  dirtySessionIds: string[];
};

export type OtelTraceAggregationResult = {
  sessionId: string;
  record: ExecutionRecord | null;
  eventCount: number;
};
