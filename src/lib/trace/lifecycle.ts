export type TimestampCarrier = {
    role?: unknown;
    content?: unknown;
    timestamp?: unknown;
    createdAt?: unknown;
    completedAt?: unknown;
    completed_at?: unknown;
    timeInfo?: { created?: unknown; completed?: unknown };
    timing?: { started_at?: unknown; completed_at?: unknown };
};

export const QUIET_WINDOW_INFERRED_FRAMEWORKS = new Set([
    'claudecode', 'jiuwenswarm', 'opencode', 'hermes', 'openclaw',
]);

export function hasAssistantOutput(interactions: TimestampCarrier[]): boolean {
    return interactions.some((interaction) => {
        const role = String(interaction?.role || '').toLowerCase();
        if (role !== 'assistant' && role !== 'subagent') return false;
        return Boolean(String(interaction?.content || '').trim());
    });
}

export function inferQuietWindowTraceCompletedAt(args: {
    framework?: unknown;
    explicitCompleted?: boolean;
    latestActivityMs?: number;
    quietLongEnough?: boolean;
}): string | null {
    const framework = String(args.framework ?? '').toLowerCase();
    if (!QUIET_WINDOW_INFERRED_FRAMEWORKS.has(framework)) return null;
    if (args.explicitCompleted) return null;
    const latestActivityMs = args.latestActivityMs || 0;
    if (!args.quietLongEnough || latestActivityMs <= 0) return null;
    return new Date(latestActivityMs).toISOString();
}
