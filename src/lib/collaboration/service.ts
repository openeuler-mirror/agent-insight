import { collaborationLog, failureDetails } from './log';
import { Binding, RelationEvent, CollaborationError } from './contracts';
import { extractCalls, resolveAnchors, Trace, Anchor } from './resolve';
import { CollaborationStore, type SavedResolution, type SavedEvent } from './store';
import { normalizeCollaborationEvent } from '@/lib/ingest/collaboration/contracts';
import { collaborationEventResolution, resolveCollaborationEventByDbId } from '@/lib/ingest/collaboration/resolve';

function parsed(value: string | null): Record<string, unknown> {
    if (!value) return {};
    try {
        const result = JSON.parse(value);
        return result && typeof result === 'object' && !Array.isArray(result) ? result : {};
    } catch { return {}; }
}

function endpoint(row: SavedResolution | undefined) {
    return {
        status: row?.linkState === 'linked' ? 'resolved' : row?.linkState === 'ambiguous' ? 'ambiguous' : 'unresolved',
        executionId: row?.executionId ?? undefined,
        method: row?.linkMethod ?? undefined,
        evidence: parsed(row?.evidenceJson ?? null),
    };
}

function preferTrace(remote: Trace['state'], stored: ReturnType<typeof endpoint>['status']): Trace['state'] {
    if (remote === 'resolved' || stored === 'resolved') return 'resolved';
    if (stored === 'ambiguous') return 'pending';
    return remote;
}

function storedAnchor(row: SavedResolution | undefined): Anchor | undefined {
    if (!row?.anchorState) return undefined;
    return { status: row.anchorState as Anchor['status'], message: '定位状态来自持久化端点解析', ...parsed(row.anchorJson) } as Anchor;
}

export class CollaborationService {
    constructor(public store: CollaborationStore) {}
    async graph(user: string, id: string, offset = 0, limit = 100, requestId?: string, nativeSessionId?: string) {
        const snapshot = nativeSessionId
            ? { total: 0, page: [] as SavedEvent[], events: [] as SavedEvent[], bindings: [] as Binding[], complete: true }
            : await this.store.snapshot(user, id, offset, limit);
        const bindings = new Map<string, Binding>(snapshot.bindings.map(binding => [binding.sessionId, binding]));
        const traces = new Map<string, Trace>();
        const allEvents = snapshot.events.map(row => JSON.parse(row.bodyJson) as RelationEvent);
        const pageEvents = snapshot.page.map(row => JSON.parse(row.bodyJson) as RelationEvent);
        const participants = new Set((snapshot.complete ? allEvents : pageEvents).flatMap(event => [event.fromSessionId, event.toSessionId]));
        if (nativeSessionId) participants.add(nativeSessionId);
        let bytesRead = 0;
        let callsRead = 0;
        let budgetExceeded = false;
        const readTrace = async (sessionId: string) => {
            if (traces.has(sessionId) || budgetExceeded) return;
            try {
                let binding = bindings.get(sessionId);
                if (!binding) {
                    const identified = await this.store.identify(user, id, sessionId);
                    binding = identified.binding;
                    if (!binding) { traces.set(sessionId, { state: 'unresolved', message: identified.message }); return; }
                    bindings.set(sessionId, binding);
                }
                const trace = await this.store.trace(user, binding);
                if (!trace) traces.set(sessionId, { state: 'unresolved', message: '对应 Trace 正文尚未到达' });
                else if (trace.state === 'pending') traces.set(sessionId, trace);
                else {
                    bytesRead += trace.byteCount;
                    if (bytesRead > 32 * 1024 * 1024) { budgetExceeded = true; return; }
                    const calls = extractCalls(trace.interactions, binding.traceSessionId, trace.execution?.framework);
                    callsRead += calls.length;
                    if (callsRead > 100000) { budgetExceeded = true; return; }
                    traces.set(sessionId, calls.length > 20000 ? { state: 'pending', message: '超过 20000 条调用解析限制' } : {
                        state: 'resolved', calls, traceSessionId: binding.traceSessionId,
                        executionId: trace.execution?.id, name: trace.execution?.agentName ?? undefined,
                    });
                }
            } catch (error) {
                collaborationLog.warn('Trace 关联暂不可用', { requestId, user, collaborationId: id, sessionId, stage: 'trace_resolution', ...failureDetails(error) });
                traces.set(sessionId, { state: 'pending', message: 'Trace 查询暂不可用，稍后重试' });
            }
        };
        const ids = [...participants];
        if (snapshot.complete && ids.length <= 200) {
            for (let index = 0; index < ids.length && index < 200 && !budgetExceeded; index++) {
                await readTrace(ids[index]);
                for (const call of traces.get(ids[index])?.calls ?? []) {
                    if (call.failed || call.targets.length !== 1) continue;
                    const target = call.targets[0];
                    const known = [...bindings].find(([, binding]) => binding.traceSessionId === target)?.[0] ?? target;
                    if (!ids.includes(known)) {
                        if (ids.length >= 201) { budgetExceeded = true; break; }
                        ids.push(known);
                    }
                }
            }
        }
        let complete = snapshot.complete && ids.length <= 200 && !budgetExceeded;
        const anchors = complete ? resolveAnchors(allEvents, bindings, traces) : new Map();
        let storedRows: SavedResolution[] = [];
        try { storedRows = await this.store.resolutions(snapshot.page.map(row => row.id)); }
        catch (error) {
            collaborationLog.warn('持久化端点解析暂不可用', { requestId, user, collaborationId: id, stage: 'endpoint_resolution', ...failureDetails(error) });
        }
        const storedByEvent = new Map<string, SavedResolution[]>();
        for (const row of storedRows) storedByEvent.set(row.eventDbId, [...(storedByEvent.get(row.eventDbId) ?? []), row]);
        const pageIds = new Set(pageEvents.flatMap(event => [event.fromSessionId, event.toSessionId]));
        if (nativeSessionId) pageIds.add(nativeSessionId);
        const automaticEvents: Array<RelationEvent & { sources: string[]; fromAnchor: Anchor; receivedAt?: string }> = [];
        const alias = (target: string) => [...bindings].find(([, binding]) => binding.traceSessionId === target)?.[0] ?? target;
        for (const [source, trace] of traces) for (const call of trace.calls ?? []) {
            if (automaticEvents.length >= 2000) { complete = false; break; }
            if (call.failed || call.targets.length !== 1) continue;
            const target = alias(call.targets[0]);
            if ((!pageIds.has(source) || !pageIds.has(target)) && pageIds.size >= 199) { complete = false; continue; }
            pageIds.add(source); pageIds.add(target);
            const confirmed = allEvents.filter(event => event.fromSessionId === source && event.toSessionId === target
                && anchors.get(event.eventId)?.status === 'confirmed' && anchors.get(event.eventId)?.position?.callKey === call.key);
            if (confirmed.length === 1) continue;
            automaticEvents.push({ collaborationId: id, eventId: `trace:${source}:${call.key}:${target}`, fromSessionId: source,
                toSessionId: target, description: `${call.name} 调用`, sources: ['trace'],
                ...(call.startedAt ? { observedAt: new Date(call.startedAt).toISOString() } : {}),
                fromAnchor: { status: 'confirmed', message: '原始工具记录包含明确目标会话编号',
                    ...(call.recordId ? { matchedRecord: { recordType: 'tool', recordId: call.recordId } } : {}),
                    position: { interactionIndex: call.interactionIndex, callIndex: call.callIndex, callKey: call.key, recordSource: call.recordSource } },
            });
        }
        const storedBySession = new Map<string, SavedResolution[]>();
        snapshot.page.forEach((row, index) => {
            const event = pageEvents[index];
            for (const resolution of storedByEvent.get(row.id) ?? []) {
                const sessionId = resolution.side === 'from' ? event.fromSessionId : event.toSessionId;
                storedBySession.set(sessionId, [...(storedBySession.get(sessionId) ?? []), resolution]);
            }
        });
        return {
            collaborationId: id, taskStatus: 'unknown', automaticEvents, total: snapshot.total, offset, limit,
            nextOffset: offset + snapshot.page.length < snapshot.total ? offset + snapshot.page.length : null,
            resolutionComplete: complete,
            nodes: [...pageIds].map(sessionId => {
                const trace = traces.get(sessionId);
                const persisted = storedBySession.get(sessionId) ?? [];
                const executionIds = [...new Set(persisted.map(item => item.executionId).filter((value): value is string => Boolean(value)))];
                return { sessionId, name: trace?.name ?? sessionId, traceResolution: trace?.state ?? 'unresolved',
                    traceSessionId: trace?.traceSessionId, executionId: trace?.executionId ?? (executionIds.length === 1 ? executionIds[0] : undefined),
                    message: trace?.state === 'resolved' ? undefined : trace?.message ?? (complete ? '对应 Trace 尚未到达' : '超过单次解析容量，保留会话关系') };
            }),
            events: snapshot.page.map((row, index) => {
                const event = pageEvents[index];
                const resolutions = storedByEvent.get(row.id) ?? [];
                const fromEndpoint = endpoint(resolutions.find(item => item.side === 'from'));
                const toEndpoint = endpoint(resolutions.find(item => item.side === 'to'));
                const persistedAnchor = storedAnchor(resolutions.find(item => item.side === 'from'));
                const resolvedAnchor = anchors.get(event.eventId) ?? { status: 'pending', message: '超过单次解析容量，未对不完整数据执行定位' };
                const fromAnchor = row.sourceType === 'goal-plus-semantic' && persistedAnchor ? persistedAnchor : resolvedAnchor;
                return { ...event, sourceType: row.sourceType, receivedAt: row.receivedAt,
                    sources: fromAnchor.status === 'confirmed' ? [row.sourceType, 'trace'] : [row.sourceType],
                    traceResolution: {
                        from: traces.get(event.fromSessionId)?.state ?? 'unresolved',
                        to: traces.get(event.toSessionId)?.state ?? 'unresolved',
                    },
                    endpointResolutions: { from: fromEndpoint, to: toEndpoint }, fromAnchor };
            }),
        };
    }
    async nativeGraph(user: string, taskId: string) {
        const identified = await this.store.identify(user, 'native', taskId);
        if (!identified.binding || !await this.store.trace(user, identified.binding)) throw new CollaborationError(404, 'NOT_FOUND', 'Trace 不存在或无权访问');
        return this.graph(user, 'native', 0, 100, undefined, taskId);
    }
    async report(user: string, event: RelationEvent, requestId?: string) {
        const normalized = normalizeCollaborationEvent({ ...event, sourceType: 'reported' });
        const reported: RelationEvent = {
            collaborationId: normalized.collaborationId, eventId: normalized.eventId,
            fromSessionId: normalized.fromSessionId, toSessionId: normalized.toSessionId,
            description: normalized.description,
            ...(normalized.observedAt ? { observedAt: normalized.observedAt } : {}),
            ...(normalized.content !== undefined ? { content: normalized.content } : {}),
            ...(normalized.fromLocator ? { fromLocator: normalized.fromLocator } : {}),
        };
        const { saved, result } = await this.store.saveEvent(user, reported);
        try { await resolveCollaborationEventByDbId(saved.id); }
        catch (error) {
            collaborationLog.warn('事件已保存，端点关联暂不可用', { requestId, user, collaborationId: event.collaborationId, eventId: event.eventId, stage: 'endpoint_resolution', ...failureDetails(error) });
        }
        let resolution: { traceResolution: { from: Trace['state']; to: Trace['state'] }; fromAnchor: Anchor } = {
            traceResolution: { from: 'pending', to: 'pending' }, fromAnchor: { status: 'pending', message: '事件已保存，稍后查询定位结果' },
        };
        try {
            // Resolve the requested event without assuming it is on the first display page.
            const snapshot = await this.store.snapshot(user, event.collaborationId, 0, 1);
            const index = snapshot.events.findIndex(row => row.eventId === event.eventId);
            if (index >= 0) {
                const graph = await this.graph(user, event.collaborationId, index, 1, requestId);
                const resolved = graph.events.find(item => item.eventId === event.eventId);
                if (resolved) resolution = { traceResolution: resolved.traceResolution, fromAnchor: resolved.fromAnchor };
            }
        } catch (error) {
            collaborationLog.warn('事件已保存，定位查询暂不可用', { requestId, user, collaborationId: event.collaborationId, eventId: event.eventId, stage: 'post_save_resolution', ...failureDetails(error) });
        }
        const persisted = await collaborationEventResolution(saved.id).catch(() => null);
        if (persisted) {
            resolution.traceResolution = {
                from: preferTrace(resolution.traceResolution.from, persisted.endpointResolutions.from.status),
                to: preferTrace(resolution.traceResolution.to, persisted.endpointResolutions.to.status),
            };
            const currentRank = ['confirmed', 'time_ordered', 'candidate', 'ambiguous', 'not_found', 'not_provided'].indexOf(resolution.fromAnchor.status);
            const persistedRank = ['confirmed', 'time_ordered', 'candidate', 'ambiguous', 'not_found', 'not_provided'].indexOf(String(persisted.fromAnchor.status));
            if (persistedRank >= 0 && (currentRank < 0 || persistedRank < currentRank)) resolution.fromAnchor = persisted.fromAnchor as Anchor;
        }
        return { collaborationId: event.collaborationId, eventId: event.eventId, result, receivedAt: saved.receivedAt,
            ...resolution, endpointResolutions: persisted?.endpointResolutions,
            detailApiPath: `/api/observe/collaborations/${encodeURIComponent(event.collaborationId)}` };
    }
}
