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

/** Only the root reviewer is internal; a business trace may contain reviewer children. */
export function isInternalRasJudgeSnapshot(data: {
    framework?: unknown;
    agent?: unknown;
    agentName?: unknown;
    interactions?: unknown;
}): boolean {
    if (String(data.framework ?? '').toLowerCase() !== 'opencode') return false;
    const explicit = String(data.agentName || data.agent || '').trim().toLowerCase();
    if (explicit) return explicit === 'ras-judge';
    if (!Array.isArray(data.interactions)) return false;
    const root = data.interactions.find((message) =>
        message && typeof message === 'object'
        && !message.subagent_session_id
        && ['user', 'assistant'].includes(String(message.role || '').toLowerCase()));
    return String(root?.agent || root?.agentName || '').trim().toLowerCase() === 'ras-judge';
}
