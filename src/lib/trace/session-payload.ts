import { createHash } from 'node:crypto';

function previewText(value: unknown, maxChars = 240): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (trimmed.length <= maxChars) return value;
    return `${trimmed.slice(0, maxChars)}…`;
}

function pickTaskOrSkillArguments(name: string, raw: unknown): unknown {
    if (typeof raw !== 'string') return raw;
    const normalizedName = name.toLowerCase();
    if (!['task', 'skill', 'load_skill', 'skill_view', 'skill_tool'].includes(normalizedName)) {
        return raw.length <= 240 ? raw : '{}';
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return previewText(raw);
        const source = parsed as Record<string, unknown>;
        const keys = normalizedName === 'task'
            ? ['subagent_type', 'subagentType', 'session_id', 'sessionId', 'subagent_session_id', 'subagentSessionId', 'description']
            : ['name', 'skill_name', 'skillName', 'skill', 'version'];
        const picked: Record<string, unknown> = {};
        for (const key of keys) {
            if (source[key] !== undefined) picked[key] = source[key];
        }
        return JSON.stringify(picked);
    } catch {
        return previewText(raw);
    }
}

function pickTaskOutput(name: string, value: unknown): unknown {
    if (name.toLowerCase() !== 'task' || value == null) return undefined;
    const visit = (input: unknown, depth = 0): unknown => {
        if (input == null || depth > 3) return undefined;
        if (typeof input === 'string') {
            if (input.length <= 240) return input;
            try {
                return visit(JSON.parse(input), depth + 1);
            } catch {
                return undefined;
            }
        }
        if (Array.isArray(input)) {
            const values = input.map(item => visit(item, depth + 1)).filter(item => item !== undefined);
            return values.length ? values : undefined;
        }
        if (typeof input === 'object') {
            const source = input as Record<string, unknown>;
            const picked: Record<string, unknown> = {};
            for (const key of ['session_id', 'sessionId', 'subagent_session_id', 'subagentSessionId']) {
                if (source[key] !== undefined) picked[key] = source[key];
            }
            for (const [key, item] of Object.entries(source)) {
                if (Object.keys(picked).length > 0) break;
                const nested = visit(item, depth + 1);
                if (nested !== undefined) picked[key] = nested;
            }
            return Object.keys(picked).length ? picked : undefined;
        }
        return undefined;
    };
    return visit(value);
}

export function toTraceStructureInteractions(interactions: any[]): any[] {
    return interactions.map((interaction, index) => {
        const source = interaction && typeof interaction === 'object' ? interaction : {};
        const metadata = { ...source };
        for (const key of [
            'content', 'parts', 'tool_calls', 'requestMessages', 'responseMessage',
            'raw', 'body', 'input', 'output', 'result', 'reasoning',
        ]) delete metadata[key];
        const toolCalls = Array.isArray(source.tool_calls)
            ? source.tool_calls.map((call: any) => {
                const name = String(call?.function?.name || call?.name || '');
                const argumentsValue = call?.function?.arguments ?? call?.arguments;
                const pickedArguments = pickTaskOrSkillArguments(name, argumentsValue);
                const pickedOutput = pickTaskOutput(name, call?.output ?? call?.result);
                return {
                    id: call?.id,
                    type: call?.type,
                    name: call?.name,
                    function: call?.function ? { name: call.function.name, arguments: pickedArguments } : undefined,
                    arguments: call?.function ? undefined : pickedArguments,
                    state: call?.state,
                    timing: call?.timing,
                    trace_split_parallel_task: call?.trace_split_parallel_task,
                    ...(pickedOutput !== undefined ? { output: pickedOutput } : {}),
                };
            })
            : undefined;
        const parts = Array.isArray(source.parts)
            ? source.parts.map((part: any) => ({
                type: part?.type,
                id: part?.id,
                tool: part?.tool,
                callID: part?.callID,
                text: previewText(part?.text),
                state: part?.state ? { status: part.state.status } : undefined,
            }))
            : undefined;
        return {
            ...metadata,
            content: previewText(source.content),
            parts,
            tool_calls: toolCalls,
            _interactionIndex: index,
            _payloadDeferred: true,
        };
    });
}

export function withTracePayloadVersions(interactions: any[]): any[] {
    return interactions.map(interaction => ({
        ...interaction,
        _payloadVersion: createHash('sha256').update(JSON.stringify(interaction)).digest('base64url'),
    }));
}
