export interface OptimizationVersionRecord {
  baseVersion: number;
  candidateVersionLabel?: string | null;
  publishedVersion?: number | null;
}

export function getOptimizationTargetVersion(record: OptimizationVersionRecord) {
  if (Number.isInteger(record.publishedVersion)) return `v${record.publishedVersion}`;
  const candidate = record.candidateVersionLabel?.match(/v\d+(?:\.\d+)*(?:-[a-z0-9.-]+)?/i)?.[0];
  return candidate || `v${record.baseVersion + 1}`;
}

export function getOptimizationTransitionLabel(record: OptimizationVersionRecord) {
  return `v${record.baseVersion} → ${getOptimizationTargetVersion(record)}`;
}
