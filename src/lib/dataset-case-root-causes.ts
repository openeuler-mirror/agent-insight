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

import { createHash } from 'crypto';

export interface RootCauseItem {
  content: string;
  weight: number;
}

export type DatasetCaseRootCauseStatus = 'ready' | 'failed' | 'empty';

export interface DatasetCaseRootCauseMeta {
  status: DatasetCaseRootCauseStatus;
  expectedOutputHash: string;
  updatedAt: string;
  error?: string;
}

export function hashExpectedOutput(value: string): string {
  return createHash('sha256').update(String(value || '').trim()).digest('hex').slice(0, 16);
}

export function normalizeRootCauseItems(value: unknown): RootCauseItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .map(item => ({
      content: String(item.content || '').trim(),
      weight: typeof item.weight === 'number' && Number.isFinite(item.weight) ? item.weight : 1,
    }))
    .filter(item => Boolean(item.content));
}

export function normalizeRootCauseMeta(value: unknown): DatasetCaseRootCauseMeta | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const status =
    raw.status === 'ready' || raw.status === 'failed' || raw.status === 'empty'
      ? raw.status
      : null;
  const expectedOutputHash = String(raw.expectedOutputHash || '').trim();
  const updatedAt = String(raw.updatedAt || '').trim();
  if (!status || !expectedOutputHash || !updatedAt) return undefined;
  const error = String(raw.error || '').trim();
  return {
    status,
    expectedOutputHash,
    updatedAt,
    ...(error ? { error } : {}),
  };
}

export function canReuseRootCauseCache(
  expectedOutput: string,
  meta?: DatasetCaseRootCauseMeta,
): boolean {
  if (!meta) return false;
  return meta.expectedOutputHash === hashExpectedOutput(expectedOutput);
}
