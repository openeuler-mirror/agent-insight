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
