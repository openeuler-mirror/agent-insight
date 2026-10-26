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

import { genericOtelTraceAdapter } from './adapters/generic';
import { actrailOtelTraceAdapter } from './adapters/actrail';
import { openclawOtelTraceAdapter } from './adapters/openclaw';
import { hermesOtelTraceAdapter } from './adapters/hermes';
import { langfuseLangGraphOtelTraceAdapter } from './adapters/langfuse-langgraph';
import { llamaIndexOtelTraceAdapter } from './adapters/llamaindex';
import { piAgentOtelTraceAdapter } from './adapters/pi-agent';
import { qoderOtelTraceAdapter } from './adapters/qoder';
import { codexOtelTraceAdapter } from './adapters/codex';
import { qwenCodeOtelTraceAdapter } from './adapters/qwencode';
import { qwenpawOtelTraceAdapter } from './adapters/qwenpaw';
import { workbuddyOtelTraceAdapter } from './adapters/workbuddy';
import { mctsXgovernorOtelTraceAdapter } from './adapters/mcts-xgovernor';
import type { OtelTraceAdapter } from './adapters/types';
import type { OtelTraceEvent } from './types';

const frameworkAdapters: readonly OtelTraceAdapter[] = [
  actrailOtelTraceAdapter,
  langfuseLangGraphOtelTraceAdapter,
  hermesOtelTraceAdapter,
  qwenCodeOtelTraceAdapter,
  openclawOtelTraceAdapter,
  qwenpawOtelTraceAdapter,
  codexOtelTraceAdapter,
  llamaIndexOtelTraceAdapter,
  qoderOtelTraceAdapter,
  piAgentOtelTraceAdapter,
  workbuddyOtelTraceAdapter,
  mctsXgovernorOtelTraceAdapter,
];

const adapters: readonly OtelTraceAdapter[] = [
  ...frameworkAdapters,
  genericOtelTraceAdapter,
];

/**
 * Framework-specific collectors may emit their identity either in the OTLP
 * attribute or as a retained top-level field in canonical spool events. A
 * worktree that does not own that framework must leave the trace alone instead
 * of letting the generic fallback invent tool calls in the shared Session row.
 */
function claimsFrameworkSpecificOwnership(events: OtelTraceEvent[]): boolean {
  return events.some((event) => {
    const claims = [event.framework, event.attributes?.['agent.insight.framework']];
    return claims.some((claim) => typeof claim === 'string' && claim.trim().length > 0);
  });
}

export function getOtelTraceAdapter(events: OtelTraceEvent[]): OtelTraceAdapter | undefined {
  return frameworkAdapters.find((adapter) => adapter.matches(events)) ||
    (claimsFrameworkSpecificOwnership(events) ? undefined : genericOtelTraceAdapter);
}

export function listOtelTraceAdapters(): readonly OtelTraceAdapter[] {
  return adapters;
}
