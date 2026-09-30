export const DAY_MS = 86_400_000;

export type CleanupEvent = {
  kind: 'scanned' | 'deleted' | 'rotated' | 'skipped';
  bytes?: number;
  scannedBytes?: number;
  reason?: string;
};

export type CacheState = {
  status: 'running' | 'success' | 'failed' | 'unknown';
  lastReceivedAt: number;
  completedAt?: number;
  busy?: boolean;
};

export function cleanupEligibility(state: CacheState, now: number, normalDays = 7, abnormalDays = 14) {
  if (state.busy || !Number.isFinite(state.lastReceivedAt) || state.lastReceivedAt <= 0) {
    return { eligible: false, reason: 'busy-or-unknown-time' };
  }
  if (state.status === 'success' && state.completedAt && Number.isFinite(state.completedAt)) {
    return { eligible: now - Math.max(state.completedAt, state.lastReceivedAt) >= normalDays * DAY_MS, reason: 'completed' };
  }
  return {
    eligible: now - state.lastReceivedAt >= abnormalDays * DAY_MS,
    reason: state.status === 'running' ? 'inactive' : 'abnormal',
  };
}

export function readCleanupConfig(env: Record<string, string | undefined> = process.env) {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(env[key]);
    return !env[key] || !Number.isFinite(value) || value < min ? fallback : Math.min(max, Math.floor(value));
  };
  const boolean = (key: string, fallback: boolean) => {
    const value = env[key]?.trim().toLowerCase();
    return value === '1' || value === 'true' ? true : value === '0' || value === 'false' ? false : fallback;
  };
  const normalDays = number('AGENT_INSIGHT_OTEL_SPOOL_RETENTION_DAYS', 7, 1, 3650);
  const logMaxFileBytes = number('AGENT_INSIGHT_CLEANUP_LOG_MAX_FILE_BYTES', 50 * 1024 * 1024, 1024, 1024 ** 4);
  return {
    enabled: boolean('AGENT_INSIGHT_CLEANUP_ENABLED', true),
    dryRun: boolean('AGENT_INSIGHT_CLEANUP_DRY_RUN', false),
    startupDelayMs: number('AGENT_INSIGHT_CLEANUP_STARTUP_DELAY_MS', 60_000, 30_000, 86_400_000),
    intervalMs: number('AGENT_INSIGHT_CLEANUP_INTERVAL_MS', 3_600_000, 60_000, 86_400_000),
    pauseMs: number('AGENT_INSIGHT_CLEANUP_PAUSE_MS', 5_000, 1000, 60_000),
    maxSteps: number('AGENT_INSIGHT_CLEANUP_MAX_STEPS', 100, 1, 1000),
    sliceMs: number('AGENT_INSIGHT_CLEANUP_SLICE_MS', 50, 1, 250),
    maxReadBytes: number('AGENT_INSIGHT_CLEANUP_MAX_READ_BYTES', 1024 * 1024, 64 * 1024, 16 * 1024 * 1024),
    normalDays,
    abnormalDays: Math.max(normalDays, number('AGENT_INSIGHT_CLEANUP_ABNORMAL_DAYS', 14, 1, 3650)),
    logRetentionDays: number('AGENT_INSIGHT_CLEANUP_LOG_RETENTION_DAYS', 14, 1, 3650),
    logRotateMs: number('AGENT_INSIGHT_CLEANUP_LOG_ROTATE_HOURS', 24, 1, 8760) * 3_600_000,
    logMaxFileBytes,
    logMaxTotalBytes: Math.max(logMaxFileBytes, number('AGENT_INSIGHT_CLEANUP_LOG_MAX_TOTAL_BYTES', 1024 ** 3, 1024 ** 2, 1024 ** 4)),
    temporaryHomeRetentionMs: number('AGENT_INSIGHT_CLEANUP_TEMP_RETENTION_HOURS', 24, 1, 8760) * 3_600_000,
  };
}
