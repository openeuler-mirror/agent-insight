const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

function trimFixed(value: number, digits: number): string {
    return value.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * 注意：Execution.latency 全链路统一为毫秒（主记录与子记录一致，2026-08-03 起）。
 * 本函数输入为「秒」，仅保留给确实持有秒值的外部数据源使用；业务代码请直接用
 * formatDurationMs(毫秒)。误用会把毫秒再放大 1000 倍（见
 * docs/tasks/bugs/issue-158-pi-agent-open.md Bug 4）。
 */
export function latencySecondsToMs(latencySeconds?: number | null): number | null {
    if (latencySeconds == null || !Number.isFinite(latencySeconds) || latencySeconds <= 0) return null;
    return latencySeconds * SECOND_MS;
}

export function formatDurationMs(ms?: number | null): string {
    if (ms == null || !Number.isFinite(ms) || ms <= 0) return '-';
    if (ms < SECOND_MS) return `${Math.round(ms)}ms`;
    if (ms < MINUTE_MS) {
        const seconds = ms / SECOND_MS;
        return `${trimFixed(seconds, seconds < 10 ? 2 : 1)}s`;
    }
    if (ms < HOUR_MS) {
        const minutes = ms / MINUTE_MS;
        return `${trimFixed(minutes, minutes < 10 ? 2 : 1)}m`;
    }
    const hours = ms / HOUR_MS;
    return `${trimFixed(hours, hours < 10 ? 2 : 1)}h`;
}

export function formatLatencySeconds(latencySeconds?: number | null): string {
    return formatDurationMs(latencySecondsToMs(latencySeconds));
}
