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
