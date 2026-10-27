/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { collaborationTraceProjection } from '@/lib/collaboration/runtime';
import { sessionTraceRelations } from '@/lib/trace/session-relations';
import { resolveUser } from '@/lib/auth/auth';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import { analyzeSession } from '@/lib/engine/evaluation/judge';
import { db, prismaRaw } from '@/lib/storage/prisma';
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
    execution?: {
        status?: string;
        sourceKind?: string;
        sourceExecutionId?: string;
        latency: number | null;
        tokens: number | null;
        cost: number | null;
        timestamp: Date | null;
    };
    executionSummary?: {
        latency: number | null;
        tokens: number | null;
        cost: number | null;
        timestamp: Date | null;
    };
    thread?: TraceThreadDto;
    interactions: any[];
    langfuseTraceNodes: LangfuseTraceNode[];
};

type TraceThreadDto = {
    id: string;
    sourceKind?: string;
    previousExecutionId?: string;
    nextExecutionId?: string;
    events: Array<{
        id: string;
        kind: string;
        status?: string;
        sourceTurnId?: string;
        phaseId?: string;
        startedAt: string;
        completedAt?: string;
        executionId?: string;
        relatedExecutionId?: string;
        payload?: Record<string, unknown>;
    }>;
};

const SESSION_CACHE_TTL_MS = 45_000;
const SESSION_CACHE_MAX_ENTRIES = 8;
const parsedSessionCache = new Map<string, {
    signature: string;
    expiresAt: number;
    value: ParsedSession;
}>();

function sessionSignature(
    session: any,
    framework: unknown,
    execution?: Record<string, unknown>,
    thread?: TraceThreadDto,
): string {
    const raw = [session?.interactions, session?.langfuseTraceNodes]
        .map(value => typeof value === 'string' ? value : '')
        .join('\n');
    const executionSignature = execution
        ? JSON.stringify([
            execution.sourceKind,
            execution.sourceExecutionId,
            execution.executionStatus,
            execution.latency,
            execution.tokens,
            execution.cost,
            execution.timestamp instanceof Date ? execution.timestamp.getTime() : execution.timestamp,
        ])
        : '';
    const threadSignature = thread ? JSON.stringify(thread) : '';
    return `${String(framework || '')}:${executionSignature}:${createHash('sha1').update(`${raw}\n${threadSignature}`).digest('base64url')}`;
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

function parsePayload(raw: string | null | undefined): Record<string, unknown> | undefined {
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
    } catch {
        return undefined;
    }
}

async function loadTraceThread(traceThreadId: string | null | undefined, user: string, currentExecutionId: string): Promise<TraceThreadDto | undefined> {
    if (!traceThreadId || process.env.DB_HOST) return undefined;
    const thread = await prismaRaw.traceThread.findFirst({
        where: { id: traceThreadId, user },
        include: {
            events: { orderBy: { startedAt: 'asc' } },
            executions: {
                orderBy: { timestamp: 'asc' },
                select: { id: true, taskId: true, sourceExecutionId: true },
            },
        },
    });
    if (!thread) return undefined;
    const taskIdByExecutionId = new Map(thread.executions.map((item) => [item.id, item.taskId || item.id]));
    const currentIndex = thread.executions.findIndex((item) => item.id === currentExecutionId);
    const previous = currentIndex > 0 ? thread.executions[currentIndex - 1] : undefined;
    const next = currentIndex >= 0 && currentIndex < thread.executions.length - 1
        ? thread.executions[currentIndex + 1]
        : undefined;
    return {
        id: thread.id,
        sourceKind: thread.sourceKind || undefined,
        previousExecutionId: previous ? previous.taskId || previous.id : undefined,
        nextExecutionId: next ? next.taskId || next.id : undefined,
        events: thread.events.map((event) => ({
            id: event.id,
            kind: event.kind,
            status: event.status || undefined,
            sourceTurnId: event.sourceTurnId || undefined,
            phaseId: event.phaseId || undefined,
            startedAt: event.startedAt.toISOString(),
            completedAt: event.completedAt?.toISOString(),
            executionId: event.executionId ? taskIdByExecutionId.get(event.executionId) : undefined,
            relatedExecutionId: event.relatedExecutionId ? taskIdByExecutionId.get(event.relatedExecutionId) : undefined,
            payload: parsePayload(event.payloadJson),
        })),
    };
}

async function loadParsedSession(taskId: string, user?: string): Promise<ParsedSession | null> {
    const session = await db.findSessionByTaskId(taskId);
    if (!session || (user !== undefined && session.user !== user)) return null;

    const owner = user ?? session.user ?? '';
    const executions = await db.findExecutions({ taskId, user: owner }, { timestamp: 'desc' }, {
        id: true,
        framework: true,
        latency: true,
        tokens: true,
        cost: true,
        timestamp: true,
        traceThreadId: true,
        sourceKind: true,
        sourceExecutionId: true,
        executionStatus: true,
    });
    const executionRow = executions?.[0];
    const framework = executionRow?.framework;
    const thread = executionRow
        ? await loadTraceThread(executionRow.traceThreadId, owner, executionRow.id)
        : undefined;
    const signature = sessionSignature(session, framework, executionRow, thread);
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
    const execution = executionRow ? {
        status: executionRow.executionStatus || undefined,
        sourceKind: executionRow.sourceKind || undefined,
        sourceExecutionId: executionRow.sourceExecutionId || undefined,
        latency: executionRow.latency ?? null,
        tokens: executionRow.tokens ?? null,
        cost: executionRow.cost ?? null,
        timestamp: executionRow.timestamp ?? null,
    } : undefined;
    const executionSummary = executionRow ? {
        latency: executionRow.latency ?? null,
        tokens: executionRow.tokens ?? null,
        cost: executionRow.cost ?? null,
        timestamp: executionRow.timestamp ?? null,
    } : undefined;
    const value = { session, execution, executionSummary, thread, interactions, langfuseTraceNodes };
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
        const child = await loadParsedSession(ref.taskId, user);
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
    const user = searchParams.get('user');
    const view = searchParams.get('view') || 'full';

    if (!taskId) {
        return NextResponse.json({ error: 'Missing taskId' }, { status: 400 });
    }

    try {
        // user 参数可选：显式提供时做归属校验（防止跨用户读取）；未提供时由
        // resolveUser 的 API key 校验兜底（username 与 session.user 不符即 403）。
        const parsed = await loadParsedSession(taskId, user || undefined);
        if (!parsed) {
            return NextResponse.json({ error: 'Session not found' }, { status: 404 });
        }
        const { session, execution, thread, interactions, langfuseTraceNodes, executionSummary } = parsed;
        const { username } = await resolveUser(request);
        if (username && session.user && username !== session.user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        const rawInteraction = searchParams.get('source') === 'raw';
        const relationPlan = !rawInteraction && username && username === session.user
            ? await collaborationTraceProjection.plan(username) : null;
        const reportedInteractions = relationPlan && username
            ? await collaborationTraceProjection.interactions(username, taskId, (id: string) => loadParsedSession(id, username || undefined), relationPlan) : null;
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
                ...(execution ? { execution } : {}),
                ...(thread ? { thread } : {}),
            });
        }

        const traceRelations = relationPlan && username && (view === 'structure' || view === 'full')
            ? await sessionTraceRelations(db, username, [...new Set<string>([taskId, ...displayInteractions.flatMap(item =>
                item._collaboration?.taskId ? [item._collaboration.taskId] : [])])], relationPlan) : undefined;
        const parentAgent = traceRelations?.[taskId]?.parent ?? null;

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
                ...(execution ? { execution } : {}),
                ...(thread ? { thread } : {}),
                parentAgent,
                traceRelations,
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
                ...(execution ? { execution } : {}),
                ...(thread ? { thread } : {}),
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
            parentAgent,
            traceRelations,
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
            ...(execution ? { execution } : {}),
            ...(thread ? { thread } : {}),
        });
    } catch (e) {
        console.error('Error reading session from DB:', e);
        return NextResponse.json({ error: 'Failed to read session' }, { status: 500 });
    }
}
