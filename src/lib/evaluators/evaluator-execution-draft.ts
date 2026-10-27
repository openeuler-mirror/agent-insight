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

import type { EvaluatorCard } from './custom-evaluator-model';
import {
  INITIAL_UNIFORM_CONFIG, normalizeEvaluatorAttemptConfig,
  type EvaluatorAttemptConfig, type EvaluatorExecutionCapabilities, type EvaluatorExecutionConfig,
} from './evaluator-execution-config';

export type AttemptDraft = { attemptTimeoutSeconds: string; maxRetries: string };
export type ExecutionDraft = { mode: 'system' | 'uniform'; uniform: AttemptDraft; overrides: Record<string, AttemptDraft> };
export function attemptDraft(config: EvaluatorAttemptConfig): AttemptDraft {
  return { attemptTimeoutSeconds: String(config.attemptTimeoutSeconds), maxRetries: String(config.maxRetries) };
}
export function executionDraft(config?: EvaluatorExecutionConfig | null): ExecutionDraft {
  return {
    mode: config?.mode ?? 'system', uniform: attemptDraft(config?.uniform ?? INITIAL_UNIFORM_CONFIG),
    overrides: Object.fromEntries(Object.entries(config?.overrides ?? {}).map(([id, value]) => [id, attemptDraft(value)])),
  };
}
export function effectiveAttemptDraft(draft: ExecutionDraft, id: string, defaults: EvaluatorAttemptConfig): AttemptDraft {
  return draft.overrides[id] ?? (draft.mode === 'uniform' ? draft.uniform : attemptDraft(defaults));
}
export function restoreEvaluatorDraft(draft: ExecutionDraft, id: string): ExecutionDraft {
  const overrides = { ...draft.overrides };
  delete overrides[id];
  return { ...draft, overrides };
}
export function parseAttemptDraft(draft: AttemptDraft): EvaluatorAttemptConfig {
  return normalizeEvaluatorAttemptConfig({
    attemptTimeoutSeconds: draft.attemptTimeoutSeconds.trim() ? Number(draft.attemptTimeoutSeconds) : NaN,
    maxRetries: draft.maxRetries.trim() ? Number(draft.maxRetries) : NaN,
  });
}
export function buildExecutionConfig(draft: ExecutionDraft, selected: ReadonlySet<string>, capabilities: EvaluatorExecutionCapabilities): EvaluatorExecutionConfig | undefined {
  const supported = [...selected].filter((id) => Object.hasOwn(capabilities, id));
  if (!supported.length) return undefined;
  const overrides = Object.fromEntries(supported.filter((id) => Object.hasOwn(draft.overrides, id))
    .map((id) => [id, parseAttemptDraft(draft.overrides[id])]));
  return { mode: draft.mode, ...(draft.mode === 'uniform' ? { uniform: parseAttemptDraft(draft.uniform) } : {}), overrides };
}

export type EvaluatorSourceFilter = 'all' | 'preset' | 'custom' | 'benchmark';
export function filterEvaluatorCards(cards: EvaluatorCard[], search: string, source: EvaluatorSourceFilter): EvaluatorCard[] {
  const query = search.trim().toLocaleLowerCase();
  return cards.filter((card) => {
    const category = card.id.startsWith('benchmark:') ? 'benchmark' : card.source;
    return (source === 'all' || source === category) && `${card.name} ${card.description}`.toLocaleLowerCase().includes(query);
  });
}
