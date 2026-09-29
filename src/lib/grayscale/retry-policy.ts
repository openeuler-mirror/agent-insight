import { isTraceGenerationFailureRetryable } from '@/lib/engine/experiment/trace-retry-policy';

export interface GrayscaleRetryRunLike {
  status?: string;
  sessionId?: string;
  failureType?: string;
  failureCode?: string;
  evaluations?: Array<{ status?: string }>;
}

export function shouldAutoRetryGrayscaleExecution(run: GrayscaleRetryRunLike, clientExecution: boolean): boolean {
  // 客户端链路已完成自己的重试预算，外层不能再启动一轮完整执行。
  return !clientExecution && run.status === 'fail' && run.failureType === 'agent_error'
    && isTraceGenerationFailureRetryable(run.failureCode || '');
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
