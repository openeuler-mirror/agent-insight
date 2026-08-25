import type { ExecutionRecord } from '@/lib/storage/data-service';

export type DeepSeekHarnessOtelEvent = {
  receivedAt: string;
  eventTimestamp: string;
  sessionId: string;
  sourceSessionId?: string;
  eventType: string;
  sequence?: number;
  user: string;
  resource: Record<string, any>;
  attributes: Record<string, any>;
  scope: { name?: string; version?: string };
  body?: any;
};

export type DeepSeekHarnessOtelAppendResult = {
  events: DeepSeekHarnessOtelEvent[];
  dirtySessionIds: string[];
};

export type DeepSeekHarnessOtelAggregationResult =
  | {
    sessionId: string;
    record: ExecutionRecord;
    eventCount: number;
    disposition: 'persisted';
  }
  | {
    sessionId: string;
    record: null;
    eventCount: number;
    disposition: 'retry-later' | 'discard';
  };
