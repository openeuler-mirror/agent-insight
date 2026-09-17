import { Binding, canonical, Locator, RelationEvent } from './contracts';

export type Call = {
    key: string; recordId?: string; recordSource?: 'tool_calls' | 'parts'; interactionIndex: number; callIndex: number; name: string;
    command?: string; startedAt?: number; timeSource?: string; targets: string[]; failed: boolean;
};
export type Trace = {
    state: 'resolved' | 'pending' | 'unresolved'; message?: string; calls?: Call[];
    executionId?: string; traceSessionId?: string; name?: string;
};
export type Anchor = {
    status: 'not_provided' | 'waiting_trace' | 'not_found' | 'candidate' | 'ambiguous' | 'pending' | 'confirmed' | 'time_ordered';
    message: string; candidateCount?: number; orderIndex?: number;
    matchedRecord?: { recordType: 'tool'; recordId: string };
    position?: { interactionIndex: number; callIndex: number; callKey: string; recordSource?: 'tool_calls' | 'parts' };
    candidates?: Array<{ name: string; recordId?: string; interactionIndex: number; callIndex: number }>;
};
const shellFields: Record<string, string> = {
    bash: 'command', Bash: 'command', shell: 'command', run_shell_command: 'command',
    exec_command: 'cmd', 'functions.exec_command': 'cmd', execute_command: 'command',
};
function decoded(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return undefined; }
}
function targetIds(value: unknown, depth = 0): string[] {
    if (depth > 3) return [];
    const obj = decoded(value);
    if (!obj || typeof obj !== 'object') return [];
    if (Array.isArray(obj)) return obj.flatMap(item => targetIds(item, depth + 1));
    const record = obj as Record<string, unknown>;
    const direct = ['session_id', 'sessionId', 'subagent_session_id', 'subagentSessionId'].flatMap(key => typeof record[key] === 'string' && record[key] ? [record[key] as string] : []);
    return [...new Set([...direct, ...['data', 'result', 'output'].flatMap(key => targetIds(record[key], depth + 1))])];
}
function timestamp(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
}
export function extractCalls(interactions: unknown[], traceSessionId: string, framework?: string | null): Call[] {
    const result: Call[] = [];
    const seen = new Map<string, Call>();
    interactions.forEach((it, interactionIndex) => {
        if (!it || typeof it !== 'object') return;
        const interaction = it as Record<string, unknown>;
        if (interaction.subagent_session_id && interaction.subagent_session_id !== traceSessionId) return;
        const calls = Array.isArray(interaction.tool_calls) ? interaction.tool_calls : [];
        const parts = Array.isArray(interaction.parts) ? interaction.parts.flatMap((part, index) => {
            if (!part || typeof part !== 'object' || (part as Record<string, unknown>).type !== 'tool') return [];
            return [{ ...(part as Record<string, unknown>), originalPartIndex: index }];
        }) : [];
        for (const [callIndex, value] of [...calls, ...parts].entries()) {
            if (!value || typeof value !== 'object') continue;
            const raw = value as Record<string, unknown>;
            const part = callIndex >= calls.length;
            const state = raw.state && typeof raw.state === 'object' ? raw.state as Record<string, unknown> : {};
            const fn = raw.function && typeof raw.function === 'object' ? raw.function as Record<string, unknown> : {};
            const timing = raw.timing && typeof raw.timing === 'object' ? raw.timing as Record<string, unknown> : {};
            const stateTime = state.time && typeof state.time === 'object' ? state.time as Record<string, unknown> : {};
            const name = part ? raw.tool : fn.name ?? raw.name;
            if (typeof name !== 'string') continue;
            const args = decoded(part ? state.input : fn.arguments ?? raw.arguments);
            const argRecord = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
            const output = part ? state.output : raw.output ?? raw.result;
            const id = part ? raw.callID : raw.id;
            const recordId = typeof id === 'string' && id ? id : undefined;
            const key = recordId ? `id:${recordId}` : `position:${interactionIndex}:${callIndex}`;
            const status = typeof state.status === 'string' ? state.status : typeof raw.state === 'string' ? raw.state : '';
            const start = part && framework === 'opencode' ? timestamp(stateTime.start) : timing.source === 'execution' ? timestamp(timing.started_at) : undefined;
            const previous = seen.get(key);
            if (previous) {
                if (previous.name !== name || (previous.startedAt !== undefined && start !== undefined && previous.startedAt !== start)) throw new Error('Conflicting original call identifier');
                previous.command ??= typeof argRecord[shellFields[name]] === 'string' ? argRecord[shellFields[name]] as string : undefined;
                if (start !== undefined) { previous.startedAt = start; previous.timeSource = part ? 'opencode.part.state.time.start' : 'tool.timing.execution'; }
                previous.failed ||= ['error', 'failed', 'cancelled'].includes(status);
                previous.targets = [...new Set([...previous.targets, ...(['task', 'spawn_agent', 'subagent'].includes(name) ? [...targetIds(output), ...targetIds(args)] : [])])];
                continue;
            }
            const call: Call = {
                key, recordId, recordSource: callIndex < calls.length ? 'tool_calls' : 'parts', interactionIndex,
                callIndex: callIndex < calls.length ? callIndex : typeof raw.originalPartIndex === 'number' ? raw.originalPartIndex : callIndex,
                name, command: typeof argRecord[shellFields[name]] === 'string' ? argRecord[shellFields[name]] as string : undefined,
                startedAt: start, timeSource: start === undefined ? undefined : part ? 'opencode.part.state.time.start' : 'tool.timing.execution',
                targets: ['task', 'spawn_agent', 'subagent'].includes(name) ? [...new Set([...targetIds(output), ...targetIds(args)])] : [],
                failed: ['error', 'failed', 'cancelled'].includes(status),
            };
            result.push(call); seen.set(key, call);
        }
    });
    return result;
}
const matches = (call: Call, locator: Locator) => locator.recordType === 'tool' ? call.name === locator.name : call.command?.includes(locator.commandContains) === true;
function located(status: 'confirmed' | 'time_ordered', call: Call, count: number, message: string, orderIndex?: number): Anchor {
    return {
        status, candidateCount: count, message, ...(orderIndex ? { orderIndex } : {}),
        ...(call.recordId ? { matchedRecord: { recordType: 'tool' as const, recordId: call.recordId } } : {}),
        position: { interactionIndex: call.interactionIndex, callIndex: call.callIndex, callKey: call.key, recordSource: call.recordSource },
    };
}
export function resolveAnchors(events: RelationEvent[], bindings: Map<string, Binding>, traces: Map<string, Trace>): Map<string, Anchor> {
    const anchors = new Map<string, Anchor>();
    const groups = new Map<string, { events: RelationEvent[]; calls: Call[]; source: string }>();
    for (const event of events) {
        const trace = traces.get(event.fromSessionId);
        const target = bindings.get(event.toSessionId)?.traceSessionId;
        const all = trace?.calls ?? [];
        const candidates = event.fromLocator ? all.filter(call => matches(call, event.fromLocator!)) : [];
        const explicit = all.filter(call => target && call.targets.length === 1 && call.targets[0] === target && !call.failed && (!event.fromLocator || matches(call, event.fromLocator)));
        if (trace?.state === 'pending') anchors.set(event.eventId, { status: 'pending', message: trace.message ?? 'Trace 查询暂不可用' });
        else if (explicit.length === 1) anchors.set(event.eventId, located('confirmed', explicit[0], 1, '原始调用记录明确关联目标 Session'));
        else if (!event.fromLocator) anchors.set(event.eventId, { status: 'not_provided', message: '未提供定位配置且无唯一明确调用依据' });
        else if (trace?.state !== 'resolved') anchors.set(event.eventId, { status: 'waiting_trace', message: '等待明确绑定的发起方 Trace' });
        else {
            const status = candidates.length === 0 ? 'not_found' : candidates.length === 1 ? 'candidate' : 'ambiguous';
            anchors.set(event.eventId, {
                status, candidateCount: candidates.length,
                message: status === 'not_found' ? '未找到匹配记录或命令未采集' : status === 'candidate' ? '唯一名称或命令匹配，仅作为候选' : '多个候选，尚不能确定对应位置',
                candidates: candidates.slice(0, 10).map(({ name, recordId, interactionIndex, callIndex }) => ({ name, recordId, interactionIndex, callIndex })),
            });
        }
        if (event.fromLocator && trace?.state === 'resolved') {
            const key = canonical([event.fromSessionId, event.fromLocator]);
            const group = groups.get(key) ?? { events: [], calls: candidates, source: event.fromSessionId };
            group.events.push(event); groups.set(key, group);
        }
    }
    const directClaims = new Map<string, RelationEvent[]>();
    for (const event of events) {
        const anchor = anchors.get(event.eventId)!;
        if (anchor.status !== 'confirmed') continue;
        const key = canonical([bindings.get(event.fromSessionId)?.traceSessionId, anchor.position!.callKey]);
        directClaims.set(key, [...(directClaims.get(key) ?? []), event]);
    }
    for (const claims of directClaims.values()) if (claims.length > 1) {
        for (const event of claims) anchors.set(event.eventId, { status: 'ambiguous', candidateCount: 1, message: '多个上报事件指向同一明确调用，无法判定是否同一次联系' });
    }
    for (const group of groups.values()) {
        if (group.calls.length < 2) continue;
        const binding = bindings.get(group.source);
        const reject = (message: string) => {
            for (const event of group.events) if (anchors.get(event.eventId)?.status !== 'confirmed') anchors.set(event.eventId, { status: 'ambiguous', candidateCount: group.calls.length, message });
        };
        if (group.calls.length !== group.events.length) { reject('调用数与事件数不同，等待完整数据'); continue; }
        if (!binding || binding.eventClock === 'unknown') { reject('事件时钟来源或跨机器可比性未声明'); continue; }
        if (group.calls.some(c => c.startedAt === undefined || !c.timeSource) || group.events.some(e => !e.observedAt)) { reject('缺少执行端调用时间或事件 observedAt，不使用兜底时间'); continue; }
        if (group.calls.some(c => c.failed || c.targets.length > 1)) { reject('存在失败调用或一次调用对应多个 Session，不满足一对一假设'); continue; }
        const calls = [...group.calls].sort((a, b) => a.startedAt! - b.startedAt!);
        const ordered = [...group.events].sort((a, b) => Date.parse(a.observedAt!) - Date.parse(b.observedAt!));
        if (new Set(calls.map(c => c.startedAt)).size !== calls.length || new Set(ordered.map(e => Date.parse(e.observedAt!))).size !== ordered.length) { reject('时间并列，不能按接收顺序或 ID 打破并列'); continue; }
        const overlap = [...groups.values()].some(other => other !== group && bindings.get(other.source)?.traceSessionId === binding.traceSessionId && other.calls.some(call => calls.some(c => c.key === call.key)));
        if (overlap) { reject('不同定位组命中相同调用，无法消歧'); continue; }
        const conflict = ordered.some((event, index) => {
            const anchor = anchors.get(event.eventId)!;
            const target = bindings.get(event.toSessionId)?.traceSessionId;
            const claims = directClaims.get(canonical([binding.traceSessionId, calls[index].key])) ?? [];
            return (anchor.status === 'confirmed' && anchor.position?.callKey !== calls[index].key)
                || (claims.length > 0 && (claims.length !== 1 || claims[0].eventId !== event.eventId))
                || (calls[index].targets.length > 0 && (!target || calls[index].targets[0] !== target));
        });
        if (conflict) { reject('顺序与明确调用证据冲突，保留明确对应'); continue; }
        ordered.forEach((event, index) => {
            if (anchors.get(event.eventId)?.status !== 'confirmed') anchors.set(event.eventId, located('time_ordered', calls[index], calls.length, '按当前已收到数据的时间顺序推定，后续数据到达可能改变', index + 1));
        });
    }
    return anchors;
}
