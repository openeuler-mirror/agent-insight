export interface GrayscaleTraceCaseRecord {
  upload_id?: string;
  task_id?: string;
  query?: string;
  dataset_id?: string;
  dataset_name?: string;
}

export interface GrayscaleTraceCaseItem {
  id: string;
  input: string;
  datasetName: string;
  datasetId: string;
  sourceType: 'trace';
  sourceExecutionSessionId: string;
  sourceUploadId: string;
  sourceDatasetId: string;
  sourceDatasetName: string;
}

export interface GrayscaleRunLike {
  runIndex?: number;
  sessionId?: string;
}

export function extractDebugJobTokenUsage(stats: unknown): number {
  const obj = (stats || {}) as { totalTokens?: unknown; tokenUsage?: unknown; tokens?: unknown };
  const candidates = [obj.totalTokens, obj.tokenUsage, obj.tokens];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value);
    if (value && typeof value === 'object') {
      const tokenObj = value as Record<string, unknown>;
      const sum = ['input', 'output', 'reasoning', 'cache'].reduce((acc, key) => {
        const n = tokenObj[key];
        return acc + (typeof n === 'number' && Number.isFinite(n) ? n : 0);
      }, 0);
      if (sum > 0) return Math.round(sum);
    }
  }
  return 0;
}

export function buildGrayscaleTraceCaseId(record: GrayscaleTraceCaseRecord, index: number): string {
  const taskId = typeof record.task_id === 'string' ? record.task_id.trim() : '';
  const uploadId = typeof record.upload_id === 'string' ? record.upload_id.trim() : '';
  if (taskId && uploadId) return `trace:${taskId}:${uploadId}`;
  if (taskId) return `trace:${taskId}`;
  if (uploadId) return `trace:upload:${uploadId}`;
  return `trace:index:${index}`;
}

export function buildGrayscaleTraceCase(record: GrayscaleTraceCaseRecord, index: number): GrayscaleTraceCaseItem {
  const sourceExecutionSessionId = typeof record.task_id === 'string' ? record.task_id.trim() : '';
  const sourceUploadId = typeof record.upload_id === 'string' ? record.upload_id.trim() : '';
  const sourceDatasetId = typeof record.dataset_id === 'string' ? record.dataset_id.trim() : '';
  const sourceDatasetName = typeof record.dataset_name === 'string' ? record.dataset_name.trim() : '';
  return {
    id: buildGrayscaleTraceCaseId(record, index),
    input: String(record.query || sourceExecutionSessionId || sourceUploadId || `trace_${index}`),
    datasetName: sourceDatasetName || 'Traces',
    datasetId: sourceDatasetId || 'traces',
    sourceType: 'trace',
    sourceExecutionSessionId,
    sourceUploadId,
    sourceDatasetId,
    sourceDatasetName,
  };
}

export function findLatestRunnableRunIndex(runs: GrayscaleRunLike[] | undefined): number | null {
  if (!Array.isArray(runs) || runs.length === 0) return null;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (!run?.sessionId) continue;
    const runIndex = typeof run.runIndex === 'number' && Number.isFinite(run.runIndex) ? run.runIndex : null;
    if (runIndex != null) return runIndex;
  }
  return null;
}
