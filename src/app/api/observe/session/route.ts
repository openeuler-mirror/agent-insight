import { collaborationTraceProjection } from '@/lib/collaboration/runtime';
import { resolveUser } from '@/lib/auth/auth';
/* eslint-disable @typescript-eslint/no-explicit-any */
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
import { createTracePayloadSnapshot } from '@/lib/trace/session-payload';
import { createSessionBodyCache, memoizeSessionReads } from '@/lib/trace/session-body-cache';

type ParsedSession = {
    session: any;
    interactions: any[];
    payloadSnapshot: ReturnType<typeof createTracePayloadSnapshot>;
    langfuseTraceNodes: LangfuseTraceNode[];
    executionSummary: {
        latency: number | null;
        tokens: number | null;
        cost: number | null;
        timestamp: Date | null;
    } | null;
};

const sessionBodies = createSessionBodyCache((raw: string, nodes: string, framework: string) => {
    const rawInteractions = raw ? JSON.parse(raw) : [];
    let langfuseTraceNodes: LangfuseTraceNode[] = [];
    try {
        const parsed = nodes ? JSON.parse(nodes) : [];
        if (Array.isArray(parsed)) langfuseTraceNodes = parsed;
    } catch {}
    const sessionInteractions = framework === 'claudecode'
        ? normalizeClaudeCodeInteractionsForStorage(rawInteractions)
        : rawInteractions;
    const interactions = inferSubagentNamesFromInteractions(sessionInteractions);
    return { interactions, langfuseTraceNodes, payloadSnapshot: createTracePayloadSnapshot(interactions) };
});

async function loadParsedSession(taskId: string): Promise<ParsedSession | null> {
    const session = await db.findSessionByTaskId(taskId);
    if (!session) return null;

    const executions = await db.findExecutions(
        { taskId },
        { timestamp: 'desc' },
        { framework: true, latency: true, tokens: true, cost: true, timestamp: true },
    );
    const latestExecution = executions?.[0] ?? null;
    const body = sessionBodies.get(
        taskId,
        session.interactions || '',
        session.langfuseTraceNodes || '',
        latestExecution?.framework || '',
    );
    const executionSummary = latestExecution ? {
        latency: latestExecution.latency ?? null,
        tokens: latestExecution.tokens ?? null,
        cost: latestExecution.cost ?? null,
        timestamp: latestExecution.timestamp ?? null,
    } : null;
    return { session, ...body, executionSummary };
}

async function loadCollaborationProjection(taskId: string, parsed: ParsedSession, load: typeof loadParsedSession) {
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
        const child = await load(ref.taskId);
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
        const load = memoizeSessionReads(loadParsedSession);
        const parsed = await load(taskId);
        if (!parsed) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }
        const { session, interactions, langfuseTraceNodes, executionSummary } = parsed;
        const { username } = await resolveUser(request);
        if (username && session.user && username !== session.user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        const rawInteraction = searchParams.get('source') === 'raw';
        const relationPlan = !rawInteraction && username && username === session.user
            ? await collaborationTraceProjection.plan(username) : null;
        const parentAgent = relationPlan?.unavailable ? { state: 'unavailable' }
            : relationPlan?.parentAgents?.[taskId] ?? null;
        const reportedInteractions = relationPlan && username
            ? await collaborationTraceProjection.interactions(username, taskId, load, relationPlan) : null;
        const collaborationProjection = reportedInteractions || rawInteraction ? null : await loadCollaborationProjection(taskId, parsed, load);
        const displayInteractions = reportedInteractions || collaborationProjection?.interactions || interactions;
        const payloadSnapshot = displayInteractions === interactions
            ? parsed.payloadSnapshot : createTracePayloadSnapshot(displayInteractions);

        if (view === 'interaction') {
            const index = Number.parseInt(String(searchParams.get('index') || ''), 10);
            if (!Number.isInteger(index) || index < 0 || index >= displayInteractions.length) {
                return NextResponse.json({ error: 'Interaction index out of range' }, { status: 400 });
            }
            return NextResponse.json({
                taskId: session.taskId,
                index,
                interaction: payloadSnapshot.interaction(index),
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
                interactions: payloadSnapshot.structure(),
                execution: executionSummary,
                parentAgent,
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
                interactions: payloadSnapshot.interactions(),
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
            interactions: payloadSnapshot.interactions(),
            parentAgent,
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
