type TraceDisplaySource = 'snapshot' | 'execution' | 'missing';

export type TraceExecutionDisplay = {
    id: string;
    taskId: string | null;
    query: string | null;
    finalResult: string | null;
    framework: string | null;
    model: string | null;
    agentName: string | null;
    timestamp: Date | string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function firstNonEmptyString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed) return trimmed;
    }
    return '';
}

export function resolveTrajectoryTraceDisplay(
    rawAnalysis: Record<string, unknown> | null,
    execution?: TraceExecutionDisplay | null,
): {
    traceInput: string | null;
    traceInputSource: TraceDisplaySource;
    traceOutput: string | null;
    traceOutputSource: TraceDisplaySource;
} {
    const caseSnapshot = asRecord(rawAnalysis?.caseSnapshot);
    const snapshotInput = firstNonEmptyString(
        caseSnapshot?.taskInput,
        caseSnapshot?.rawTaskInput,
        caseSnapshot?.input,
    );
    const snapshotOutput = firstNonEmptyString(rawAnalysis?.resultActualOutput);
    const executionInput = firstNonEmptyString(execution?.query);
    const executionOutput = firstNonEmptyString(execution?.finalResult);

    return {
        traceInput: snapshotInput || executionInput || null,
        traceInputSource: snapshotInput ? 'snapshot' : executionInput ? 'execution' : 'missing',
        traceOutput: snapshotOutput || executionOutput || null,
        traceOutputSource: snapshotOutput ? 'snapshot' : executionOutput ? 'execution' : 'missing',
    };
}
