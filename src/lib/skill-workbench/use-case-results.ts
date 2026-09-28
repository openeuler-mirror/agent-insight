import type { AbRunState, AbEvaluationState } from './ab-comparison';

export interface ExistingTraceCase {
  id: string;
  taskId?: string | null;
  input?: string;
  actualOutput?: string;
  referenceOutput?: string | null;
}

export interface CaseEvaluationResult {
  id: string;
  caseId: string;
  evaluatorId: string;
  status: string;
  score: number | null;
  summary?: string | null;
  errorMessage?: string | null;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function evaluationScoreState(
  evaluatorIds: string[],
  evaluations: Array<{ evaluatorId: string; status?: string; score?: number | null }>,
  fallbackStatus: string,
): { score: number | null; status: string } {
  if (!evaluatorIds.length) return { score: null, status: 'not-evaluated' };
  const byId = new Map(evaluations.map((item) => [item.evaluatorId, item]));
  const selected = evaluatorIds.map((id) => byId.get(id));
  if (fallbackStatus === 'cancelled' && selected.some((item) => !item || ['pending', 'running'].includes(item.status || ''))) return { score: null, status: 'cancelled' };
  if (selected.some((item) => item?.status === 'running')) return { score: null, status: 'evaluating' };
  if (selected.some((item) => item?.status === 'pending')) return { score: null, status: ['pending', 'running', 'evaluating'].includes(fallbackStatus) ? fallbackStatus : 'executed' };
  if (selected.some((item) => !item)) return { score: null, status: fallbackStatus };
  if (selected.some((item) => item?.status === 'failed')) return { score: null, status: 'failed' };
  if (selected.every((item) => item?.status === 'done')) {
    const scores = selected.map((item) => item?.score);
    return scores.every(finite)
      ? { score: scores.reduce((sum, score) => sum + score, 0) / scores.length, status: 'done' }
      : { score: null, status: 'unscored' };
  }
  return { score: null, status: fallbackStatus };
}

export function existingTraceCaseRun(
  row: ExistingTraceCase,
  results: CaseEvaluationResult[],
  evaluatorIds: string[],
  experimentStatus: string,
): AbRunState {
  const evaluations: AbEvaluationState[] = results
    .filter((item) => item.caseId === row.id && evaluatorIds.includes(item.evaluatorId))
    .map((item) => ({
      evaluatorId: item.evaluatorId,
      evaluationResultId: item.id,
      status: item.status,
      score: finite(item.score) ? item.score : undefined,
      unscored: item.status === 'done' && !finite(item.score),
      summary: item.summary || undefined,
      errorMessage: item.errorMessage || undefined,
    }));
  const fallback = experimentStatus === 'cancelled' ? 'cancelled'
    : ['done', 'failed', 'partial'].includes(experimentStatus) ? 'failed' : 'executed';
  const aggregate = evaluationScoreState(evaluatorIds, evaluations, fallback);
  return {
    experimentCaseId: row.id,
    sessionId: row.taskId || undefined,
    output: row.actualOutput || '',
    evaluations,
    score: aggregate.score ?? undefined,
    status: aggregate.status,
  };
}

export function existingTraceRetryResults(
  caseId: string, results: CaseEvaluationResult[], evaluatorIds: string[],
): CaseEvaluationResult[] {
  const byId = new Map(results.filter((item) => item.caseId === caseId).map((item) => [item.evaluatorId, item]));
  const selected = evaluatorIds.map((id) => byId.get(id));
  if (selected.some((item) => item && !['done', 'failed'].includes(item.status))) return [];
  const failed = selected.filter((item): item is CaseEvaluationResult => item?.status === 'failed');
  if (failed.length) return failed;
  return selected.every((item) => item?.status === 'done') ? selected as CaseEvaluationResult[] : [];
}

export function categoryAverage(
  breakdown: Array<{ evaluatorId: string; avg: number | null; scored: number }>,
  evaluatorIds: string[],
): number | null {
  const rows = breakdown.filter((item) => evaluatorIds.includes(item.evaluatorId) && finite(item.avg) && item.scored > 0);
  const count = rows.reduce((sum, item) => sum + item.scored, 0);
  return count ? rows.reduce((sum, item) => sum + item.avg! * item.scored, 0) / count : null;
}
