import type { RawInteraction } from '@/lib/engine/observability/agent-trace';

export interface InferenceAnalysisTarget {
    scope: 'trace' | 'llm';
    sessionIds: string[];
    responseId?: string;
    requestId?: string;
    attemptIds?: string[];
    callIds?: string[];
    unassignedCallIds?: string[];
    unavailableReason?: 'unsupported' | 'session' | 'response' | 'request';
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
    const text = (value?: string) => value?.trim() || undefined;
    const responseId = text(interaction?.inference_response_id);
    const requestId = text(interaction?.inference_request_id);
    const unique = (values: Array<string | undefined>) => [...new Set(values.map(text).filter((id): id is string => !!id))];
    if (scope === 'trace') {
        const unassigned = unique(interactions.flatMap(it => (it.inference_unassigned_calls ?? []).map(call => call.call_id)));
        const callIds = unique([...interactions.flatMap(it => it.inference_call_ids ?? []), ...unassigned]);
        if (callIds.length) return { ...target, callIds, unassignedCallIds: unassigned,
            sessionIds: unique([rootSessionId, ...interactions.map(it => it.inference_session_id)]) };
    } else if (interaction?.inference_call_ids?.length) {
        return { ...target, callIds: unique(interaction.inference_call_ids), sessionIds: unique([interaction.inference_session_id]) };
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
