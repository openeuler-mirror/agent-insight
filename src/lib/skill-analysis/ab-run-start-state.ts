type PendingRun = {
  status: 'pending';
  caseId: string;
  runIndex: number;
  roundIndex: number;
};

type PendingSideState = {
  status: 'running';
  runs: PendingRun[];
  runCount: number;
};

export const AB_EVALUATOR_RETRY_DISPATCH_STATUS = 'pending' as const;

export function buildOptimisticAbRunStates(caseIds: string[], repeatRounds: number): Record<string, {
  a: PendingSideState;
  b: PendingSideState;
}> {
  const rounds = Math.max(1, Math.floor(Number(repeatRounds) || 1));
  return Object.fromEntries(caseIds.map(caseId => {
    const buildSide = (): PendingSideState => ({
      status: 'running',
      runCount: rounds,
      runs: Array.from({ length: rounds }, (_, index) => ({
        status: 'pending',
        caseId,
        runIndex: index + 1,
        roundIndex: index + 1,
      })),
    });
    return [caseId, { a: buildSide(), b: buildSide() }];
  }));
}
