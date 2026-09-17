import { resolveUser } from '@/lib/auth/auth';
import { collaborationProjection as reportedTraceProjection } from '@/lib/collaboration/runtime';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { analyzeSession } from '@/lib/engine/evaluation/judge';
import { db } from '@/lib/storage/prisma';
import { inferSubagentNamesFromInteractions } from '@/lib/engine/observability/subagent-inference';
import { normalizeClaudeCodeInteractionsForStorage } from '@/lib/shared/interaction-content';
import { NextResponse } from 'next/server';
import type { LangfuseTraceNode } from '@/lib/ingest/otel/adapters/langfuse-trace';
import { findGoalPlusTraceProjectionMembers } from '@/lib/ingest/collaboration/query';
import {
    composeCollaborationTrace,
    type CollaborationTraceMember,
} from '@/lib/ingest/collaboration/trace-projection';
import { toTraceStructureInteractions, withTracePayloadVersions } from '@/lib/trace/session-payload';

type ParsedSession = {
    session: any;
    interactions: any[];
    langfuseTraceNodes: LangfuseTraceNode[];
    executionSummary: {
        latency: number | null;
        tokens: number | null;
        cost: number | null;
        timestamp: Date | null;
    } | null;
};

const SESSION_CACHE_TTL_MS = 45_000;
const SESSION_CACHE_MAX_ENTRIES = 8;
const parsedSessionCache = new Map<string, {
    signature: string;
    expiresAt: number;
    value: ParsedSession;
}>();

function sessionSignature(session: any, execution: any): string {
    const raw = [session?.interactions, session?.langfuseTraceNodes]
        .map(value => typeof value === 'string' ? value : '')
        .join('\n');
    const executionVersion = [
        execution?.framework,
        execution?.latency,
        execution?.tokens,
        execution?.cost,
        execution?.timestamp instanceof Date
            ? execution.timestamp.getTime()
            : execution?.timestamp,
    ].map(value => String(value ?? '')).join(':');
    return `${executionVersion}:${createHash('sha1').update(raw).digest('base64url')}`;
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

    const executions = await db.findExecutions(
        { taskId },
        { timestamp: 'desc' },
        { framework: true, latency: true, tokens: true, cost: true, timestamp: true },
    );
    const latestExecution = executions?.[0] ?? null;
    const framework = latestExecution?.framework;
    const signature = sessionSignature(session, latestExecution);
    const cached = parsedSessionCache.get(taskId);
    if (cached && cached.signature === signature && cached.expiresAt > Date.now()) {
        return cached.value;
    }

    const rawInteractions = session.interactions ? JSON.parse(session.interactions) : [];
    let langfuseTraceNodes: LangfuseTraceNode[] = [];
    try {
        const parsed = session.langfuseTraceNodes ? JSON.parse(session.langfuseTraceNodes) : [];
        if (Array.isArray(parsed)) langfuseTraceNodes = parsed;
    } catch {}
    const sessionInteractions = framework === 'claudecode'
        ? normalizeClaudeCodeInteractionsForStorage(rawInteractions)
        : rawInteractions;
    const interactions = inferSubagentNamesFromInteractions(sessionInteractions);
    const executionSummary = latestExecution ? {
        latency: latestExecution.latency ?? null,
        tokens: latestExecution.tokens ?? null,
        cost: latestExecution.cost ?? null,
        timestamp: latestExecution.timestamp ?? null,
    } : null;
    const value = { session, interactions, langfuseTraceNodes, executionSummary };
    rememberParsedSession(taskId, signature, value);
    return value;
}

async function loadCollaborationProjection(taskId: string, parsed: ParsedSession) {
    const user = typeof parsed.session?.user === 'string' ? parsed.session.user : '';
    if (!user) return null;
    const storedQuery = typeof parsed.session?.query === 'string' ? parsed.session.query.trim() : '';
    const interactionQuery = parsed.interactions.find(interaction => (
        interaction?.role === 'user' && typeof interaction?.content === 'string' && interaction.content.trim()
    ))?.content;
    const rootQuery = storedQuery || interactionQuery || null;
    let refs;
    try {
        refs = await findGoalPlusTraceProjectionMembers(user, taskId, rootQuery);
    } catch (error) {
        console.warn(`[Session-API] Goal Plus trace projection unavailable for task=${taskId}:`, error);
        return null;
    }
    if (!refs.members.length) return null;

    const loadedMembers = await Promise.all(refs.members.map(async (ref): Promise<CollaborationTraceMember | null> => {
        const child = await loadParsedSession(ref.taskId);
        if (!child || child.session?.user !== user) return null;
        return {
            ...ref,
            interactions: child.interactions,
            query: child.session?.query,
        };
    }));
    const members = loadedMembers.filter((member): member is CollaborationTraceMember => member !== null);
    const missingMembers = refs.members.length - members.length;
    const projection = composeCollaborationTrace(parsed.interactions, members);
    if (!projection.includedMembers) return null;
    return {
        ...projection,
        truncated: projection.truncated || refs.truncated || missingMembers > 0,
        availableMembers: refs.members.length,
        sourceType: 'goal-plus-semantic',
        rootResolution: refs.rootResolution,
    };
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
        const { session, interactions, langfuseTraceNodes, executionSummary } = parsed;
        const { username } = await resolveUser(request);
        if (username && session.user && username !== session.user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        const rawInteraction = view === 'interaction' && searchParams.get('source') === 'raw';
        const reportedInteractions = !rawInteraction && username && username === session.user
            ? await reportedTraceProjection.interactions(username, taskId, loadParsedSession) : null;
        const collaborationProjection = reportedInteractions || rawInteraction ? null : await loadCollaborationProjection(taskId, parsed);
        const displayInteractions = withTracePayloadVersions(reportedInteractions || collaborationProjection?.interactions || interactions);

        if (view === 'interaction') {
            const index = Number.parseInt(String(searchParams.get('index') || ''), 10);
            if (!Number.isInteger(index) || index < 0 || index >= displayInteractions.length) {
                return NextResponse.json({ error: 'Interaction index out of range' }, { status: 400 });
            }
            return NextResponse.json({
                taskId: session.taskId,
                index,
                interaction: displayInteractions[index],
            });
        }

        if (view === 'structure') {
            return NextResponse.json({
                taskId: session.taskId,
                label: session.label,
                query: session.query,
                user: session.user,
                startTime: session.startTime.getTime(),
                interactionCount: displayInteractions.length,
                interactions: toTraceStructureInteractions(displayInteractions),
                execution: executionSummary,
                ...(collaborationProjection ? {
                    collaborationProjection: {
                        sourceType: collaborationProjection.sourceType,
                        rootResolution: collaborationProjection.rootResolution,
                        includedMembers: collaborationProjection.includedMembers,
                        availableMembers: collaborationProjection.availableMembers,
                        truncated: collaborationProjection.truncated,
                    },
                } : {}),
                ...(langfuseTraceNodes.length && !reportedInteractions ? { langfuseTraceNodes } : {}),
            });
        }

        if (view === 'interactions') {
            return NextResponse.json({
                taskId: session.taskId,
                interactions: displayInteractions,
                ...(collaborationProjection ? {
                    collaborationProjection: {
                        sourceType: collaborationProjection.sourceType,
                        rootResolution: collaborationProjection.rootResolution,
                        includedMembers: collaborationProjection.includedMembers,
                        availableMembers: collaborationProjection.availableMembers,
                        truncated: collaborationProjection.truncated,
                    },
                } : {}),
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
            interactions: displayInteractions,
            ...(collaborationProjection ? {
                collaborationProjection: {
                    sourceType: collaborationProjection.sourceType,
                    rootResolution: collaborationProjection.rootResolution,
                    includedMembers: collaborationProjection.includedMembers,
                    availableMembers: collaborationProjection.availableMembers,
                    truncated: collaborationProjection.truncated,
                },
            } : {}),
            ...(langfuseTraceNodes.length && !reportedInteractions ? { langfuseTraceNodes } : {}),
        });
    } catch (e) {
        console.error('Error reading session from DB:', e);
        return NextResponse.json({ error: 'Failed to read session' }, { status: 500 });
    }
}
