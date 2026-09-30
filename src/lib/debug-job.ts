export interface DebugJob {
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  output?: string;
  timeCost?: string;
  tokenUsage?: number;
  sessionId?: string;
  error?: string;
}
