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

/** Shared identity for the builtin reliability evaluation dataset. */
export const BUILTIN_RELIABILITY_DATASET_NAME = '可靠性故障注入评测集（内置）'

export function isBuiltinReliabilityDataset(dataset: {
  name?: string | null
  tags?: string[] | null
}): boolean {
  if (String(dataset.name || '').trim() === BUILTIN_RELIABILITY_DATASET_NAME) return true
  const tags = Array.isArray(dataset.tags) ? dataset.tags.map((t) => String(t)) : []
  return tags.includes('内置') && tags.includes('reliability')
}
