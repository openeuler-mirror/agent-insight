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

const DEFAULT_USER_TAG_LIMIT = 20;
const LEGACY_BUSINESS_TAG_LIMIT = 50;

function parseTagIds(value: string | null, limit: number): string[] {
  return Array.from(new Set(
    String(value || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean),
  )).slice(0, limit);
}

export interface ObserveTraceTagFilters {
  userTagIds: string[];
  legacyBusinessTagIds: string[];
}

export function parseObserveTraceTagFilters(searchParams: URLSearchParams): ObserveTraceTagFilters {
  const userTagIds = parseTagIds(searchParams.get('tagIds'), DEFAULT_USER_TAG_LIMIT);
  return {
    userTagIds,
    legacyBusinessTagIds: userTagIds.length > 0
      ? []
      : parseTagIds(searchParams.get('bizTag'), LEGACY_BUSINESS_TAG_LIMIT),
  };
}

export function executionIdsMatchingAllTags(
  rows: ReadonlyArray<{ executionId: string; tagId: string }>,
  tagIdsInput: readonly string[],
): string[] {
  const tagIds = Array.from(new Set(tagIdsInput.map(value => String(value || '').trim()).filter(Boolean)));
  if (tagIds.length === 0) return [];
  const expected = new Set(tagIds);
  const matches = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!expected.has(row.tagId)) continue;
    const executionMatches = matches.get(row.executionId) ?? new Set<string>();
    executionMatches.add(row.tagId);
    matches.set(row.executionId, executionMatches);
  }

  return Array.from(matches.entries())
    .filter(([, matchedTagIds]) => matchedTagIds.size === expected.size)
    .map(([executionId]) => executionId);
}
