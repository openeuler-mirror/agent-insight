import type { ExecutionRecord } from '@/lib/storage/data-service';

export type ClaudeOtelEvent = {
  receivedAt: string;
  eventName: string;
  eventTimestamp?: string;
  sequence?: number;
  sessionId: string;
  promptId?: string;
  user?: string;
  resource: Record<string, any>;
  attributes: Record<string, any>;
  body?: any;
  traceId?: string;
  spanId?: string;
};

export type ClaudeOtelAppendResult = {
  events: ClaudeOtelEvent[];
  dirtySessionIds: string[];
};

export type OtelTraceEvent = {
  receivedAt: string;
  sessionId: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind: 'llm' | 'tool';
  serviceName: string;
  user?: string;
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

export type ClaudeOtelAggregationResult = {
  sessionId: string;
  record: ExecutionRecord | null;
  eventCount: number;
};

export type OtelTraceAggregationResult = {
  sessionId: string;
  record: ExecutionRecord | null;
  eventCount: number;
};
