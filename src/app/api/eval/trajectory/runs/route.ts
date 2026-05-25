import { NextResponse } from 'next/server';
import { prismaRaw as prisma } from '@/lib/storage/prisma';
import { extractTrajectoryTaskMeta } from '@/lib/eval/trajectory-task-meta';
import { isEvaluatorAgentName } from '@/lib/evaluator-agent';

export const dynamic = 'force-dynamic';

function safeParse<T>(s: string | null | undefined, fallback: T): T {
    if (!s) return fallback;
    try {
        return JSON.parse(s) as T;
    } catch {
        return fallback;
    }
}

function pickResultEvaluationScore(rawAnalysisJson: string | null | undefined): number | null {
    const raw = safeParse(rawAnalysisJson, null) as {
        resultEvaluation?: { score?: unknown };
        score?: unknown;
    } | null;
    const candidates = [raw?.resultEvaluation?.score, raw?.score];
    for (const value of candidates) {
        if (typeof value === 'number' && !Number.isNaN(value)) return value;
    }
    return null;
}

function hasSelectedEvaluator(raw: { selectedEvaluators?: string[] }, evaluatorId: string): boolean {
    const selected = Array.isArray(raw.selectedEvaluators) ? raw.selectedEvaluators : [];
    if (selected.length === 0) return evaluatorId === 'preset-agent-trace-quality';
    return selected.includes(evaluatorId);
}

function getEffectiveStatus(row: { status: string; rawAnalysisJson?: string | null }): string {
    const raw = safeParse(row.rawAnalysisJson, {}) as { resultEvaluationError?: unknown };
    return row.status === 'done' && typeof raw.resultEvaluationError === 'string' && raw.resultEvaluationError.trim()
        ? 'failed'
        : row.status;
}

function getEvaluatorIds(rows: Array<{ rawAnalysisJson?: string | null }>): string[] {
    const ids = Array.from(new Set(rows.flatMap(row => {
        const raw = safeParse(row.rawAnalysisJson, {}) as { selectedEvaluators?: unknown };
        return Array.isArray(raw.selectedEvaluators) ? raw.selectedEvaluators.filter((id): id is string => typeof id === 'string') : [];
    })));
    return ids.length > 0 ? ids : ['preset-agent-trace-quality'];
}

function getEvaluatorName(rows: Array<{ rawAnalysisJson?: string | null }>): string {
    const names = Array.from(new Set(rows.flatMap(row => {
        const raw = safeParse(row.rawAnalysisJson, {}) as { selectedEvaluatorNames?: unknown };
        return Array.isArray(raw.selectedEvaluatorNames)
            ? raw.selectedEvaluatorNames.filter((name): name is string => typeof name === 'string')
            : [];
    })));
    return names.length > 0 ? names.join('、') : 'Agent 轨迹质量';
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const user = (searchParams.get('user') || '').trim();
        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });

        const limit = Math.min(Math.max(Number(searchParams.get('limit') || '10'), 1), 50);
        const offset = Math.max(Number(searchParams.get('offset') || '0'), 0);
        const autoWatchOnly = searchParams.get('autoWatchOnly') === '1' || searchParams.get('autoWatchOnly') === 'true';
        const includeRunId = (searchParams.get('includeRunId') || '').trim();

        const where: Record<string, unknown> = { user };

        const groupLimit = autoWatchOnly ? Math.max(limit * 8, 50) : limit + 1;
        const groups = await prisma.trajectoryEvalResult.groupBy({
            by: ['evaluatorRunId'],
            where,
            _min: { createdAt: true },
            orderBy: { _min: { createdAt: 'desc' } },
            skip: offset,
            take: groupLimit,
        });
        const candidateRunIds = groups
            .map(group => group.evaluatorRunId)
            .filter((id): id is string => Boolean(id));
        if (includeRunId && !candidateRunIds.includes(includeRunId)) {
            candidateRunIds.push(includeRunId);
        }

        const rows = candidateRunIds.length > 0
            ? await prisma.trajectoryEvalResult.findMany({
                where: { user, evaluatorRunId: { in: candidateRunIds } },
                orderBy: { createdAt: 'desc' },
            })
            : [];

        const byRun = new Map<string, typeof rows>();
        for (const row of rows) {
            const arr = byRun.get(row.evaluatorRunId) || [];
            arr.push(row);
            byRun.set(row.evaluatorRunId, arr);
        }
        const executionKeys = Array.from(new Set(rows.flatMap(row => [row.taskId, row.executionId].filter(Boolean) as string[])));
        const executions = executionKeys.length > 0
            ? await prisma.execution.findMany({
                where: {
                    OR: [
                        { taskId: { in: executionKeys } },
                        { id: { in: executionKeys } },
                    ],
                },
                select: {
                    id: true,
                    taskId: true,
                    agentName: true,
                },
            })
            : [];
        const executionAgentByKey = new Map<string, string>();
        for (const execution of executions) {
            const agentName = String(execution.agentName || '').trim();
            if (!agentName) continue;
            executionAgentByKey.set(execution.id, agentName);
            if (execution.taskId) executionAgentByKey.set(execution.taskId, agentName);
        }
        const sessions = executionKeys.length > 0
            ? await prisma.session.findMany({
                where: { taskId: { in: executionKeys } },
                select: { taskId: true, interactions: true },
            })
            : [];
        for (const session of sessions) {
            if (!session.interactions || executionAgentByKey.has(session.taskId)) continue;
            try {
                const interactions = JSON.parse(session.interactions);
                if (!Array.isArray(interactions)) continue;
                const agent = interactions
                    .map((item: { agent?: unknown }) => String(item.agent || '').trim())
                    .find(name => name && !isEvaluatorAgentName(name));
                if (agent) executionAgentByKey.set(session.taskId, agent);
            } catch {
                /* ignore malformed session interactions */
            }
        }

        const summaries = candidateRunIds
            .map(runId => {
                const runRows = byRun.get(runId) || [];
                const visibleRows = runRows.filter(row => {
                    const raw = safeParse(row.rawAnalysisJson, {}) as { watchPlaceholder?: unknown };
                    return raw.watchPlaceholder !== true;
                });
                const first = runRows[0];
                if (!first) return null;
                const firstRaw = safeParse(first.rawAnalysisJson, {}) as {
                    autoWatch?: unknown;
                    watchedAgent?: unknown;
                };
                const autoWatch = runRows.some(row => {
                    const raw = safeParse(row.rawAnalysisJson, {}) as { autoWatch?: unknown };
                    return raw.autoWatch === true;
                });
                if (autoWatchOnly && !autoWatch) return null;

                const earliest = runRows
                    .map(row => row.createdAt.getTime())
                    .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);
                const agentCounts = new Map<string, number>();
                for (const row of visibleRows) {
                    const agent = executionAgentByKey.get(row.taskId || '') || executionAgentByKey.get(row.executionId || '');
                    if (agent) agentCounts.set(agent, (agentCounts.get(agent) || 0) + 1);
                }
                const topAgent = Array.from(agentCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
                const taskMeta = extractTrajectoryTaskMeta(first.rawAnalysisJson, new Date(earliest));
                const doneRows = visibleRows.filter(row => getEffectiveStatus(row) === 'done');
                const scores = doneRows
                    .map(row => {
                        const raw = safeParse(row.rawAnalysisJson, {}) as { selectedEvaluators?: string[] };
                        const traceScore = hasSelectedEvaluator(raw, 'preset-agent-trace-quality') ? row.trajectoryScore : null;
                        const resultScore = hasSelectedEvaluator(raw, 'preset-agent-task-completion')
                            ? pickResultEvaluationScore(row.rawAnalysisJson)
                            : null;
                        if (typeof traceScore === 'number' && typeof resultScore === 'number') return (traceScore + resultScore) / 2;
                        return traceScore ?? resultScore ?? null;
                    })
                    .filter((score): score is number => typeof score === 'number');
                return {
                    runId,
                    datasetId: first.datasetId,
                    taskTitle: taskMeta.title,
                    taskDescription: taskMeta.description,
                    evaluatorIds: getEvaluatorIds(runRows),
                    executionAgent: topAgent || (typeof firstRaw.watchedAgent === 'string' ? firstRaw.watchedAgent : ''),
                    autoWatch,
                    watchedAgent: typeof firstRaw.watchedAgent === 'string' ? firstRaw.watchedAgent : '',
                    traceCount: visibleRows.length,
                    doneCount: doneRows.length,
                    runningCount: visibleRows.filter(row => {
                        const status = getEffectiveStatus(row);
                        return status === 'pending' || status === 'running';
                    }).length,
                    failedCount: visibleRows.filter(row => getEffectiveStatus(row) === 'failed').length,
                    avgScore: scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
                    createdAt: new Date(earliest).toISOString(),
                    evaluatorName: getEvaluatorName(runRows),
                };
            })
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        const normalPage = summaries.slice(0, limit);
        const includedIndex = includeRunId
            ? summaries.findIndex(summary => summary.runId === includeRunId)
            : -1;
        const anchorStart = includedIndex >= limit
            ? Math.max(0, Math.min(includedIndex - Math.floor(limit / 2), summaries.length - limit))
            : 0;
        const page = includedIndex >= limit
            ? summaries.slice(anchorStart, anchorStart + limit)
            : normalPage;
        const hasMore = summaries.length > limit || (autoWatchOnly ? groups.length === groupLimit : groups.length > limit);
        const nextOffset = hasMore
            ? autoWatchOnly && summaries.length <= limit
                ? offset + groups.length
                : offset + (includedIndex >= limit ? anchorStart + limit : limit)
            : null;

        return NextResponse.json({ runs: page, nextOffset, hasMore });
    } catch (error: unknown) {
        console.error('trajectory/runs GET error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'failed to load runs' },
            { status: 500 },
        );
    }
}
