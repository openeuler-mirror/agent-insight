/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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

export type ClaudeOtelAggregationResult =
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


export type { OtelTraceAggregationResult, OtelTraceAppendResult, OtelTraceEvent } from '../otel/types';
