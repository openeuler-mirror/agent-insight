import type { RawInteraction } from '@/lib/engine/observability/agent-trace';

export interface InferenceAnalysisCall {
    callId: string;
    startedAt?: string;
    statusCode?: number;
    state?: string;
    unassigned?: boolean;
    model?: string;
    messageId?: string;
    sessionId?: string;
}

export interface InferenceAnalysisTarget {
    scope: 'trace' | 'llm';
    sessionIds: string[];
    responseId?: string;
    requestId?: string;
    attemptIds?: string[];
    callIds?: string[];
    unassignedCallIds?: string[];
    calls?: InferenceAnalysisCall[];
    preferredCallId?: string;
    unavailableReason?: 'unsupported' | 'session' | 'response' | 'request';
}

const text = (value?: string) => value?.trim() || undefined;

function ownedCalls(interaction: RawInteraction): InferenceAnalysisCall[] {
    const calls = new Map<string, InferenceAnalysisCall>();
    const model = text(interaction.model) || text(interaction.modelID) || text(interaction.model_id);
    const messageId = text(interaction.messageID);
    const sessionId = text(interaction.inference_session_id);
    const context = {
        ...(model ? { model } : {}),
        ...(messageId ? { messageId } : {}),
        ...(sessionId ? { sessionId } : {}),
    };
    for (const id of interaction.inference_call_ids ?? []) {
        const callId = text(id);
        if (callId) calls.set(callId, { callId, ...context });
    }
    const requestId = text(interaction.inference_request_id);
    for (const attempt of interaction.inference_attempts ?? []) {
        const callId = text(attempt.call_id);
        if (!callId || (requestId && text(attempt.request_id) !== requestId)) continue;
        const startedAt = text(attempt.started_at);
        const state = text(attempt.state);
        calls.set(callId, {
            ...calls.get(callId), callId, ...context,
            ...(startedAt ? { startedAt } : {}),
            ...(Number.isFinite(attempt.status_code) ? { statusCode: attempt.status_code } : {}),
            ...(state ? { state } : {}),
        });
    }
    return [...calls.values()];
}

function preferredCallId(scope: InferenceAnalysisTarget['scope'], calls: InferenceAnalysisCall[]): string | undefined {
    if (calls.length === 1) return calls[0].callId;
    if (scope !== 'llm' || !calls.length) return undefined;
    const timestamps = calls.map(call => call.startedAt ? Date.parse(call.startedAt) : NaN);
    if (!timestamps.every(Number.isFinite)) return undefined;
    const latest = Math.max(...timestamps);
    const latestCalls = calls.filter((_, index) => timestamps[index] === latest);
    return latestCalls.length === 1 ? latestCalls[0].callId : undefined;
}

export function inferenceAnalysisTarget({ framework, scope, rootSessionId, interaction, interactions = [] }: {
    framework?: string;
    scope: InferenceAnalysisTarget['scope'];
    rootSessionId?: string;
    interaction?: RawInteraction & { _collaboration?: { taskId?: string } };
    interactions?: RawInteraction[];
}): InferenceAnalysisTarget {
    const target: InferenceAnalysisTarget = { scope, sessionIds: [] };
    const source = framework?.trim().toLowerCase();
    const responseId = text(interaction?.inference_response_id);
    const requestId = text(interaction?.inference_request_id);
    const unique = (values: Array<string | undefined>) => [...new Set(values.map(text).filter((id): id is string => !!id))];
    if (scope === 'trace') {
        const unassigned = unique(interactions.flatMap(it => (it.inference_unassigned_calls ?? []).map(call => call.call_id)));
        const byId = new Map<string, InferenceAnalysisCall>();
        for (const item of interactions) {
            for (const call of ownedCalls(item)) byId.set(call.callId, { ...byId.get(call.callId), ...call });
        }
        for (const item of interactions) {
            for (const call of item.inference_unassigned_calls ?? []) {
                const callId = text(call.call_id);
                if (!callId || (byId.has(callId) && !byId.get(callId)?.unassigned)) continue;
                const startedAt = text(call.started_at);
                const state = text(call.state);
                const sessionId = text(item.inference_session_id);
                byId.set(callId, {
                    ...byId.get(callId), callId, unassigned: true,
                    ...(startedAt ? { startedAt } : {}),
                    ...(Number.isFinite(call.status_code) ? { statusCode: call.status_code } : {}),
                    ...(state ? { state } : {}),
                    ...(sessionId ? { sessionId } : {}),
                });
            }
        }
        const calls = [...byId.values()];
        if (calls.length) return { ...target, calls, callIds: calls.map(call => call.callId), unassignedCallIds: unassigned,
            preferredCallId: preferredCallId(scope, calls), sessionIds: unique([rootSessionId, ...interactions.map(it => it.inference_session_id)]) };
    } else if (interaction) {
        const calls = ownedCalls(interaction);
        if (calls.length) return { ...target, calls, callIds: calls.map(call => call.callId), preferredCallId: preferredCallId(scope, calls),
            sessionIds: unique([interaction.inference_session_id]) };
    }
    if (source !== 'qoder' && source !== 'opencode' && !responseId && !requestId) return { ...target, unavailableReason: 'unsupported' };
    if (scope === 'trace') {
        target.sessionIds = [...new Set([rootSessionId, ...interactions.map(it => it.inference_session_id)].map(text).filter((id): id is string => !!id))];
        if (!target.sessionIds.length) target.unavailableReason = 'session';
        return target;
    }
    const foreignSource = interaction?._collaboration?.taskId && interaction._collaboration.taskId !== rootSessionId;
    const legacyQoder = source === 'qoder' && !foreignSource && !requestId;
    if (responseId || legacyQoder) {
        const sessionId = text(interaction?.inference_session_id) || (legacyQoder ? text(rootSessionId) : undefined);
        if (sessionId) target.sessionIds = [sessionId];
        if (!interaction?.inference_response_unavailable && interaction?.model !== '<synthetic>') target.responseId = responseId || (legacyQoder ? text(interaction?.messageID) : undefined);
        if (!target.responseId) target.unavailableReason = 'response';
    } else {
        const sessionId = text(interaction?.inference_session_id);
        if (sessionId) target.sessionIds = [sessionId];
        target.requestId = requestId;
        target.attemptIds = [...new Set((interaction?.inference_attempts ?? [])
            .filter(attempt => target.requestId && attempt.request_id === target.requestId)
            .map(attempt => text(attempt.attempt_id)).filter((id): id is string => !!id))];
        if (!target.requestId) target.unavailableReason = 'request';
    }
    if (!target.unavailableReason && !target.sessionIds.length) target.unavailableReason = 'session';
    return target;
}
