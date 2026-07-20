/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { analyzeSession } from '@/lib/engine/evaluation/judge';
import { db } from '@/lib/storage/prisma';
import { inferSubagentNamesFromInteractions } from '@/lib/engine/observability/subagent-inference';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { NextResponse } from 'next/server';

type ParsedSession = {
    session: any;
    interactions: any[];
};

const SESSION_CACHE_TTL_MS = 45_000;
const SESSION_CACHE_MAX_ENTRIES = 8;
const parsedSessionCache = new Map<string, {
    signature: string;
    expiresAt: number;
    value: ParsedSession;
}>();

function sessionSignature(session: any, framework: unknown): string {
    const raw = typeof session?.interactions === 'string' ? session.interactions : '';
    return `${String(framework || '')}:${createHash('sha1').update(raw).digest('base64url')}`;
}

function rememberParsedSession(taskId: string, signature: string, value: ParsedSession): void {
    parsedSessionCache.delete(taskId);
    parsedSessionCache.set(taskId, {
        signature,
        expiresAt: Date.now() + SESSION_CACHE_TTL_MS,
        value,
    });
    while (parsedSessionCache.size > SESSION_CACHE_MAX_ENTRIES) {
        const oldest = parsedSessionCache.keys().next().value;
        if (!oldest) break;
        parsedSessionCache.delete(oldest);
    }
}

async function loadParsedSession(taskId: string): Promise<ParsedSession | null> {
    const session = await db.findSessionByTaskId(taskId);
    if (!session) return null;

    const executions = await db.findExecutions({ taskId }, { timestamp: 'desc' }, { framework: true });
    const framework = executions?.[0]?.framework;
    const signature = sessionSignature(session, framework);
    const cached = parsedSessionCache.get(taskId);
    if (cached && cached.signature === signature && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    const rawInteractions = session.interactions ? JSON.parse(session.interactions) : [];
    const sessionInteractions = framework === 'claudecode'
        ? normalizeClaudeCodeInteractionsForStorage(rawInteractions)
        : rawInteractions;
    const interactions = inferSubagentNamesFromInteractions(sessionInteractions);
    const value = { session, interactions };
    rememberParsedSession(taskId, signature, value);
    return value;
}

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

/** 保留建树所需元数据，长正文通过 view=interaction 按 interaction index 获取。 */
export function toTraceStructureInteractions(interactions: any[]): any[] {
    return interactions.map((interaction, index) => {
        const source = interaction && typeof interaction === 'object' ? interaction : {};
        const metadata = { ...source };
        for (const key of [
            'content',
            'parts',
            'tool_calls',
            'requestMessages',
            'responseMessage',
            'raw',
            'body',
            'input',
            'output',
            'result',
            'reasoning',
        ]) {
            delete metadata[key];
        }
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
                    function: call?.function
                        ? { name: call.function.name, arguments: pickedArguments }
                        : undefined,
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

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const taskId = searchParams.get('taskId');
    const view = searchParams.get('view') || 'full';

    if (!taskId) {
        return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    try {
        const parsed = await loadParsedSession(taskId);
        if (!parsed) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }
        const { session, interactions } = parsed;

        if (view === 'interaction') {
            const index = Number.parseInt(String(searchParams.get('index') || ''), 10);
            if (!Number.isInteger(index) || index < 0 || index >= interactions.length) {
                return NextResponse.json({ error: 'Interaction index out of range' }, { status: 400 });
            }
            return NextResponse.json({
                taskId: session.taskId,
                index,
                interaction: interactions[index],
            });
        }

        if (view === 'structure') {
            return NextResponse.json({
                taskId: session.taskId,
                label: session.label,
                query: session.query,
                user: session.user,
                startTime: session.startTime.getTime(),
                interactionCount: interactions.length,
                interactions: toTraceStructureInteractions(interactions),
            });
        }

        if (view === 'interactions') {
            return NextResponse.json({
                taskId: session.taskId,
                interactions,
            });
        }

        let query = session.query;
        if (!query && interactions.length > 0) {
            try {
                const analysis = await analyzeSession(interactions, session.user);
                if (analysis.query) {
                    query = analysis.query;
                    db.updateSession(taskId, { query }).catch(console.error);
                }
            } catch (e) {
                console.warn('Failed to extract query on the fly', e);
            }
        }

        return NextResponse.json({
            taskId: session.taskId,
            label: session.label,
            query,
            user: session.user,
            startTime: session.startTime.getTime(),
            interactions,
        });
    } catch (e) {
        console.error('Error reading session from DB:', e);
        return NextResponse.json({ error: 'Failed to read session' }, { status: 500 });
    }
}
