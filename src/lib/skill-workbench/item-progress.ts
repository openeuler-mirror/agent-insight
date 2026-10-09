export interface ExperimentItemProgress {
  total: number;
  succeeded: number;
  failed: number;
  pending: number;
}

export interface ExperimentEvaluationProgress extends ExperimentItemProgress {
  skipped: number;
  unscored: number;
}

interface EvaluationLike {
  evaluatorId?: string;
  status?: string;
  score?: number | null;
  unscored?: boolean;
}

interface RunLike {
  status?: string;
  failureType?: string;
  runIndex?: number;
  roundIndex?: number;
  evaluations?: EvaluationLike[];
}

interface SideLike extends RunLike {
  runs?: RunLike[];
}

type CaseStatesLike = Record<string, { a?: SideLike; b?: SideLike }>;

interface ResultLike {
  caseId: string;
  evaluatorId: string;
  status: string;
  score?: number | null;
}

type ItemState = 'succeeded' | 'failed' | 'pending' | 'skipped' | 'unscored';

function summarize(states: ItemState[]): ExperimentItemProgress {
  return {
    total: states.length,
    succeeded: states.filter((state) => state === 'succeeded').length,
    failed: states.filter((state) => state === 'failed').length,
    pending: states.filter((state) => state === 'pending').length,
  };
}

function summarizeEvaluations(states: ItemState[]): ExperimentEvaluationProgress {
  return { ...summarize(states), skipped: states.filter(state => state === 'skipped').length, unscored: states.filter(state => state === 'unscored').length };
}

export function workbenchCompletionStatus(status: string, execution: ExperimentItemProgress, evaluation: ExperimentEvaluationProgress): string {
  if (status === 'cancelled' || !['done', 'partial', 'failed'].includes(status)) return status;
  if (execution.pending || evaluation.pending) return 'running';
  if (execution.failed || evaluation.failed) return evaluation.succeeded || evaluation.unscored ? 'partial' : 'failed';
  return 'done';
}

function sideRuns(side: SideLike | undefined, repeatRounds: number): Array<RunLike | undefined> {
  const runs = side?.runs?.length ? side.runs : side ? [side] : [];
  const byRound = new Map<number, RunLike>();
  runs.forEach((run, index) => {
    const round = Number(run.runIndex ?? run.roundIndex ?? index + 1);
    if (Number.isInteger(round) && round >= 1) byRound.set(round, run);
  });
  return Array.from({ length: repeatRounds }, (_, index) => byRound.get(index + 1));
}

function executionState(run: RunLike | undefined, settled: boolean): ItemState {
  if (!run) return settled ? 'failed' : 'pending';
  if (typeof run.failureType === 'string' && run.failureType.length > 0) return 'failed';
  if (['executed', 'evaluating', 'pass', 'fail', 'done', 'failed'].includes(run.status || '')) {
    return 'succeeded';
  }
  return settled ? 'failed' : 'pending';
}

function evaluationState(run: RunLike | undefined, evaluatorIds: string[], settled: boolean): ItemState {
  const execution = executionState(run, settled);
  if (execution === 'failed') return 'skipped';
  if (execution === 'pending' || !run) return 'pending';
  const latestByEvaluator = new Map<string, EvaluationLike>();
  for (const evaluation of run.evaluations || []) {
    if (evaluation.evaluatorId) latestByEvaluator.set(evaluation.evaluatorId, evaluation);
  }
  const configured = evaluatorIds.map((id) => latestByEvaluator.get(id));
  if (configured.some((evaluation) => ['pending', 'running'].includes(evaluation?.status || ''))) return 'pending';
  if (!settled && !['pass', 'done', 'fail', 'failed'].includes(run.status || '') && configured.some((evaluation) => !evaluation)) return 'pending';
  if (configured.some((evaluation) => evaluation?.status === 'failed')) return 'failed';
  if (configured.length > 0 && configured.every((evaluation) => evaluation?.status === 'done')) {
    return configured.some(evaluation => evaluation?.unscored || evaluation?.score === null)
      || (['fail', 'failed'].includes(run.status || '') && !configured.some(evaluation => typeof evaluation?.score === 'number'))
      ? 'unscored' : 'succeeded';
  }
  if (run.status === 'fail' || run.status === 'failed') return 'failed';
  if (run.status === 'pass' || run.status === 'done') return 'succeeded';
  return settled ? 'failed' : 'pending';
}

export function summarizeWorkbenchItemProgress(input: {
  caseIds: string[];
  executionSides: Array<'a' | 'b'>;
  repeatRounds: number;
  evaluatorIds: string[];
  caseStates: CaseStatesLike;
  settled?: boolean;
}): { executionProgress: ExperimentItemProgress; evaluationProgress: ExperimentEvaluationProgress } {
  const executionStates: ItemState[] = [];
  const evaluationStates: ItemState[] = [];
  const repeatRounds = Math.max(1, Math.floor(input.repeatRounds) || 1);
  for (const caseId of input.caseIds) {
    for (const side of input.executionSides) {
      for (const run of sideRuns(input.caseStates[caseId]?.[side], repeatRounds)) {
        executionStates.push(executionState(run, input.settled === true));
        evaluationStates.push(evaluationState(run, input.evaluatorIds, input.settled === true));
      }
    }
  }
  return {
    executionProgress: summarize(executionStates),
    evaluationProgress: summarizeEvaluations(evaluationStates),
  };
}

export function summarizeExistingTraceItemProgress(input: {
  caseIds: string[];
  evaluatorIds: string[];
  results: ResultLike[];
  settled: boolean;
}): { executionProgress: ExperimentItemProgress; evaluationProgress: ExperimentEvaluationProgress } {
  const executionStates: ItemState[] = input.caseIds.map(() => 'succeeded');
  const evaluationStates = input.caseIds.map<ItemState>((caseId) => {
    const latestByEvaluator = new Map<string, ResultLike>();
    for (const result of input.results) {
      if (result.caseId === caseId) latestByEvaluator.set(result.evaluatorId, result);
    }
    const configured = input.evaluatorIds.map((id) => latestByEvaluator.get(id));
    if (configured.some((result) => ['pending', 'running'].includes(result?.status || ''))) return 'pending';
    if (!input.settled && configured.some((result) => !result)) return 'pending';
    if (configured.some((result) => result?.status === 'failed')) return 'failed';
    if (configured.length > 0 && configured.every((result) => result?.status === 'done')) return configured.some(result => result?.score === null) ? 'unscored' : 'succeeded';
    return input.settled ? 'failed' : 'pending';
  });
  return {
    executionProgress: summarize(executionStates),
    evaluationProgress: summarizeEvaluations(evaluationStates),
  };
}
