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

import { createHash } from 'node:crypto';
import type { AgentDatasetRecord, DatasetCase } from '@/server/agent_datasets_storage';
import type { JudgeCriteria } from '@/lib/engine/evaluation/judge';

export function verificationHash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, stable(value)]))
      : item;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

export function isTriggerCase(item: DatasetCase): boolean {
  return Object.hasOwn(item.values || {}, 'should_trigger')
    || item.tags?.some((tag) => ['trigger', 'should-trigger', 'should-not-trigger'].includes(tag))
    || /^skill should (?:not )?trigger[.!]?$/i.test(item.expectedOutput?.trim() || '');
}

export function behavioralCriteria(item: DatasetCase): JudgeCriteria | null {
  if (isTriggerCase(item) || !item.input.trim()) return null;
  const roots = (item.rootCauses || []).filter((root) => root.content.trim() && Number.isFinite(root.weight) && root.weight > 0)
    .map(({ content, weight }) => ({ content, weight }));
  if (!roots.length && item.expectedOutput.trim()) roots.push({ content: item.expectedOutput.trim(), weight: 1 });
  return roots.length ? { standard_answer_example: item.expectedOutput, root_causes: roots } : null;
}

export function selectBehavioralCases(datasets: AgentDatasetRecord[], preferred: string[] = [], maxCases = 5) {
  const eligible = datasets.filter((dataset) => dataset.datasetKind === 'ideal_output'
    && !dataset.tags?.includes('trigger') && !dataset.fields?.some((field) => field.key === 'should_trigger'))
    .flatMap((dataset) => dataset.cases).filter((item) => behavioralCriteria(item));
  const ids = new Set(preferred);
  const seen = new Set<string>();
  return [...eligible.filter((item) => ids.has(item.id)), ...eligible.filter((item) => !ids.has(item.id))]
    .filter((item) => {
      const key = verificationHash({ input: item.input, criteria: behavioralCriteria(item) });
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, Math.max(0, Math.floor(maxCases)));
}

export function validJudgment(value: { score: number; reason?: string }): boolean {
  return Number.isFinite(value.score) && value.score >= 0 && value.score <= 1
    && !/Judgment API failed|未找到评分结果|配置 LLM/.test(value.reason || '');
}
