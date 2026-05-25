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

export type ClaudeOtelAggregationResult = {
  sessionId: string;
  record: ExecutionRecord | null;
  eventCount: number;
};

