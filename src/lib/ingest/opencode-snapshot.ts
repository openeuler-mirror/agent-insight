export function isInProgressOpencodeSnapshot(data: {
    framework?: unknown;
    trace_completed_at?: unknown;
    opencode_cli_completed?: unknown;
}): boolean {
    if (String(data.framework ?? '').toLowerCase() !== 'opencode') return false;
    if (data.opencode_cli_completed === true) return false;
    if (String(data.trace_completed_at ?? '').trim()) return false;
    return true;
}
