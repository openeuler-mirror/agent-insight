export interface AbEvaluationState {
  evaluatorId: string;
  evaluatorName?: string;
  status?: string;
  score?: number;
  evaluationResultId?: string;
  unscored?: boolean;
  summary?: string;
  errorMessage?: string;
}

export interface AbRunState {
  status?: string;
  experimentCaseId?: string;
  score?: number;
  output?: string;
  timeCost?: string;
  tokenUsage?: number;
  sessionId?: string;
  runIndex?: number;
  roundIndex?: number;
  evaluatorRunId?: string;
  evaluationResultId?: string;
  evaluationTraceId?: string;
  tier?: string;
  failureType?: string;
  failureCode?: string;
  failureDetail?: string;
  completedAt?: string;
  skillTriggered?: boolean;
  toolCallCount?: number;
  evaluations?: AbEvaluationState[];
}

export interface AbSideState extends AbRunState {
  runs?: AbRunState[];
}

export type AbCaseStates = Record<string, { a?: AbSideState; b?: AbSideState }>;
export type AbOutcome = 'a' | 'b' | 'tie' | 'unpaired';

export interface AbSideSummary {
  score: number | null;
  output: string;
  status: string;
  sessionId: string;
  evaluations: Array<{ evaluatorId: string; evaluatorName: string; status: string; score: number | null }>;
}

export interface AbCaseComparison {
  caseId: string;
  a: AbSideSummary;
  b: AbSideSummary;
  outcome: AbOutcome;
}

export interface AbEvaluatorComparison {
  evaluatorId: string;
  evaluatorName: string;
  aScore: number | null;
  bScore: number | null;
  coverage: number;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function formatWorkbenchScore(score: number | null | undefined, status?: string): string {
  if (finite(score)) return score.toFixed(1);
  if (status === 'not-evaluated') return '未评测';
  if (status === 'pending') return '等待执行';
  if (status === 'running') return '执行中';
  if (status === 'executed') return '待评测';
  if (status === 'evaluating') return '评测中';
  if (status === 'fail' || status === 'failed') return '失败';
  if (status === 'unscored') return '未计分';
  if (status === 'cancelled') return '已取消';
  return '—';
}

function average(values: unknown[]): number | null {
  const numbers = values.filter(finite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function runsOf(side?: AbSideState): AbRunState[] {
  return side?.runs?.length ? side.runs : side ? [side] : [];
}

export function isCompletedWorkbenchCase(experimentStatus: string, sides: Array<AbSideState | undefined>): boolean {
  const runsBySide = sides.map(runsOf);
  if (runsBySide.some((runs) => runs.some((run) => !['pass', 'fail', 'done', 'failed', 'cancelled'].includes(run.status || '')))) {
    return false;
  }
  if (runsBySide.length > 0 && runsBySide.every((runs) => runs.length > 0)) return true;
  return ['done', 'partial', 'failed', 'cancelled'].includes(experimentStatus);
}

export function summarizeAbSide(side?: AbSideState): AbSideSummary {
  const runs = runsOf(side);
  const evaluations = new Map<string, { evaluatorName: string; status: string; scores: number[] }>();
  const runEvaluations = runs.flatMap((run) => run.evaluations || []);
  for (const evaluation of runEvaluations.length ? runEvaluations : side?.evaluations || []) {
    const entry = evaluations.get(evaluation.evaluatorId) || {
      evaluatorName: evaluation.evaluatorName || evaluation.evaluatorId,
      status: evaluation.status || 'pending',
      scores: [],
    };
    if (evaluation.status) entry.status = evaluation.status;
    if (finite(evaluation.score)) entry.scores.push(evaluation.score);
    evaluations.set(evaluation.evaluatorId, entry);
  }
  const latest = [...runs].reverse();
  return {
    score: average(runs.map((run) => run.score)) ?? (finite(side?.score) ? side.score : null),
    output: latest.find((run) => typeof run.output === 'string' && run.output.trim())?.output || side?.output || '',
    status: latest.find((run) => run.status)?.status || side?.status || 'pending',
    sessionId: latest.find((run) => run.sessionId)?.sessionId || side?.sessionId || '',
    evaluations: Array.from(evaluations, ([evaluatorId, entry]) => ({
      evaluatorId,
      evaluatorName: entry.evaluatorName,
      status: entry.status,
      score: average(entry.scores),
    })),
  };
}

function outcomeOf(aScore: number | null, bScore: number | null): AbOutcome {
  if (aScore == null || bScore == null) return 'unpaired';
  if (Math.abs(aScore - bScore) < 0.05) return 'tie';
  return aScore > bScore ? 'a' : 'b';
}

export function buildAbComparison(
  caseIds: string[],
  states: AbCaseStates,
  configuredEvaluatorIds: string[],
) {
  const cases: AbCaseComparison[] = caseIds.map((caseId) => {
    const a = summarizeAbSide(states[caseId]?.a);
    const b = summarizeAbSide(states[caseId]?.b);
    return { caseId, a, b, outcome: outcomeOf(a.score, b.score) };
  });
  const comparable = cases.filter((item) => item.outcome !== 'unpaired');
  const discoveredEvaluatorIds = cases.flatMap((item) => [
    ...item.a.evaluations.map((evaluation) => evaluation.evaluatorId),
    ...item.b.evaluations.map((evaluation) => evaluation.evaluatorId),
  ]);
  const evaluatorIds = Array.from(new Set([...configuredEvaluatorIds, ...discoveredEvaluatorIds]));
  const evaluators: AbEvaluatorComparison[] = evaluatorIds.map((evaluatorId) => {
    const pairs = comparable.flatMap((item) => {
      const a = item.a.evaluations.find((evaluation) => evaluation.evaluatorId === evaluatorId);
      const b = item.b.evaluations.find((evaluation) => evaluation.evaluatorId === evaluatorId);
      return a?.score != null && b?.score != null ? [{ a: a.score, b: b.score }] : [];
    });
    const named = cases.flatMap((item) => [...item.a.evaluations, ...item.b.evaluations])
      .find((evaluation) => evaluation.evaluatorId === evaluatorId);
    return {
      evaluatorId,
      evaluatorName: named?.evaluatorName || evaluatorId,
      aScore: average(pairs.map((pair) => pair.a)),
      bScore: average(pairs.map((pair) => pair.b)),
      coverage: pairs.length,
    };
  });
  return {
    cases,
    evaluators,
    comparable: comparable.length,
    unpaired: cases.length - comparable.length,
    aWins: cases.filter((item) => item.outcome === 'a').length,
    bWins: cases.filter((item) => item.outcome === 'b').length,
    ties: cases.filter((item) => item.outcome === 'tie').length,
    aScore: average(comparable.map((item) => item.a.score)),
    bScore: average(comparable.map((item) => item.b.score)),
  };
}
