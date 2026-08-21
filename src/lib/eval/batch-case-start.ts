export interface BatchCaseStartState {
  status?: string;
  evaluatorRunId?: string;
}

export interface BatchEvaluationBinding {
  evaluationBatchId?: string;
  evalExperimentId?: string;
}

export function resolveBatchEvaluationExperimentId(
  config: BatchEvaluationBinding,
): string | undefined {
  return config.evaluationBatchId || config.evalExperimentId || undefined;
}

export function isBatchCaseStartable(
  state: BatchCaseStartState | undefined,
  currentEvaluatorRunId: string,
): boolean {
  if (!state) return true;

  if (state.evaluatorRunId && state.evaluatorRunId !== currentEvaluatorRunId) {
    return true;
  }

  return state.status === 'pending' || state.status === 'pass' || state.status === 'fail';
}
