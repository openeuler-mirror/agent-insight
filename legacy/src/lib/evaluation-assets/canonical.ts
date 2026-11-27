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
import { EvaluationAssetError, type AssetKind } from './types';

function sorted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sorted).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${sorted(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function assetContentObject(content: unknown): Record<string, unknown> {
  try {
    const cloned = JSON.parse(JSON.stringify(content));
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) throw new Error();
    return cloned;
  } catch { throw new EvaluationAssetError('资产内容必须为有效的 JSON 对象'); }
}

export function canonicalAssetJson(content: unknown): string {
  return sorted(assetContentObject(content));
}

export function semanticAssetContent(kind: AssetKind, content: unknown): Record<string, unknown> {
  const definition = assetContentObject(content);
  for (const key of ['createdAt', 'updatedAt', 'lastSeenAt', 'startedAt', 'finishedAt', 'generationStatus', 'generationProgress', 'progress', 'runtimeStatus', 'runStatus']) delete definition[key];
  if (kind === 'agent') delete definition.status;
  if (kind === 'dataset' && Array.isArray(definition.cases)) {
    definition.cases = definition.cases.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const item = { ...value } as Record<string, unknown>;
      for (const key of ['rootCauses', 'rootCauseMeta', 'createdAt', 'updatedAt']) delete item[key];
      if (item.traceSource && typeof item.traceSource === 'object' && !Array.isArray(item.traceSource)) {
        const traceSource = { ...item.traceSource } as Record<string, unknown>;
        delete traceSource.capturedAt;
        item.traceSource = traceSource;
      }
      return item;
    });
  }
  return definition;
}

export function assetContentHash(kind: AssetKind, content: unknown): string {
  return createHash('sha256').update(canonicalAssetJson(semanticAssetContent(kind, content))).digest('hex');
}
