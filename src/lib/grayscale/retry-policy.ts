export interface GrayscaleRetryRunLike {
  status?: string;
  sessionId?: string;
  failureType?: string;
  evaluations?: Array<{ status?: string }>;
}

export type GrayscaleRetryMode = 'execution' | 'evaluation';

export function resolveGrayscaleRetryMode(run: GrayscaleRetryRunLike): GrayscaleRetryMode {
  if (!run.sessionId || run.failureType) return 'execution';
  if (run.status === 'executed' || run.status === 'fail' || run.status === 'failed') {
    return 'evaluation';
  }
  return run.evaluations?.some((item) => item.status === 'failed' || item.status === 'pending')
    ? 'evaluation'
    : 'execution';
}
