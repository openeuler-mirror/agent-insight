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
