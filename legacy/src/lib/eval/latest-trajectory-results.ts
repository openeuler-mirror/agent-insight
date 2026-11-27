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

export interface DatasetCaseResultLike {
  datasetId?: string | null;
  caseId?: string | null;
}

/**
 * Rows must be ordered newest first. Dataset-backed results collapse to the
 * latest attempt per case; trace-only results remain independent records.
 */
export function selectLatestDatasetCaseResults<T extends DatasetCaseResultLike>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const datasetId = String(row.datasetId || '').trim();
    const caseId = String(row.caseId || '').trim();
    if (!datasetId || !caseId) return true;

    const key = `${datasetId}\u0000${caseId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
