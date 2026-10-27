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

const DATASET_CASE_BINDING_KEY = '__agentInsightDatasetCase';

export interface ExperimentDatasetCaseBinding {
  datasetId: string;
  caseId: string;
}

export function normalizeExperimentDatasetCaseBinding(value: unknown): ExperimentDatasetCaseBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const datasetId = String(raw.datasetId || '').trim();
  const caseId = String(raw.caseId || '').trim();
  return datasetId && caseId ? { datasetId, caseId } : null;
}

export function readExperimentDatasetCaseBinding(
  values: Record<string, unknown> | null | undefined,
): ExperimentDatasetCaseBinding | null {
  return normalizeExperimentDatasetCaseBinding(values?.[DATASET_CASE_BINDING_KEY]);
}

export function withExperimentDatasetCaseBinding(
  values: Record<string, unknown> | null | undefined,
  binding: ExperimentDatasetCaseBinding | null | undefined,
): Record<string, unknown> {
  const next = { ...(values || {}) };
  delete next[DATASET_CASE_BINDING_KEY];
  const normalized = normalizeExperimentDatasetCaseBinding(binding);
  if (normalized) next[DATASET_CASE_BINDING_KEY] = normalized;
  return next;
}

export function withoutExperimentDatasetCaseBinding(
  values: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!values) return null;
  const next = { ...values };
  delete next[DATASET_CASE_BINDING_KEY];
  return Object.keys(next).length ? next : null;
}
