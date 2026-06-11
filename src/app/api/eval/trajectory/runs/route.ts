import { NextResponse } from 'next/server';
import { prismaRaw as prisma } from '@/lib/storage/prisma';
import { extractTrajectoryTaskMeta } from '@/lib/eval/trajectory-task-meta';
import { selectLatestDatasetCaseResults } from '@/lib/eval/latest-trajectory-results';
import { getPrimaryObservedAgentName } from '@/lib/engine/observability/agent-registration';

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

export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        let body: Record<string, unknown> = {};
        try { body = await request.json(); } catch { /* allow query params fallback */ }
        const pick = (k: string) => String((body[k] as string) ?? searchParams.get(k) ?? '').trim();
        const user = pick('user');
        const runId = pick('runId');

        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });
        if (!runId) return NextResponse.json({ error: 'runId is required' }, { status: 400 });

        const rows = await prisma.trajectoryEvalResult.findMany({
            where: { user, evaluatorRunId: runId },
            select: { id: true, status: true },
        });
        if (rows.length === 0) {
            return NextResponse.json({ deletedResults: 0, deletedEvaluations: 0, deletedSkillIssues: 0 });
        }
        if (rows.some(row => row.status === 'pending' || row.status === 'running')) {
            return NextResponse.json(
                { error: '评测进行中，暂时不能删除该批次；请等待完成后再删除。' },
                { status: 409 },
            );
        }

        const evaluationIds = await prisma.evaluation.findMany({
            where: {
                user,
                type: 'dynamic',
                runId,
            },
            select: { id: true },
        });
        const skillIssueCount = evaluationIds.length > 0
            ? await prisma.skillIssue.count({
                where: {
                    evaluationId: {
                        in: evaluationIds.map(item => item.id),
                    },
                },
            })
            : 0;

        const [deletedEvaluations, deletedResults] = await prisma.$transaction([
            prisma.evaluation.deleteMany({
                where: {
                    user,
                    type: 'dynamic',
                    runId,
                },
            }),
            prisma.trajectoryEvalResult.deleteMany({
                where: {
                    user,
                    evaluatorRunId: runId,
                },
            }),
        ]);

        return NextResponse.json({
            deletedResults: deletedResults.count,
            deletedEvaluations: deletedEvaluations.count,
            deletedSkillIssues: skillIssueCount,
        });
    } catch (error: unknown) {
        console.error('trajectory/runs DELETE error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'failed to delete run' },
            { status: 500 },
        );
    }
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const user = (searchParams.get('user') || '').trim();
        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });

        const limit = Math.min(Math.max(Number(searchParams.get('limit') || '10'), 1), 50);
        const offset = Math.max(Number(searchParams.get('offset') || '0'), 0);
        const autoWatchOnly = searchParams.get('autoWatchOnly') === '1' || searchParams.get('autoWatchOnly') === 'true';
        // 用例分析(eval 页)只看独立评测任务, 不该混入灰度 A/B 的评测批次 —— A/B 批次只在 A/B 页看。
        const excludeGrayscale = searchParams.get('excludeGrayscale') === '1' || searchParams.get('excludeGrayscale') === 'true';
        const includeRunId = (searchParams.get('includeRunId') || '').trim();
        const latestByCase = searchParams.get('latestByCase') === '1' || searchParams.get('latestByCase') === 'true';
        const scope = (searchParams.get('scope') || '').trim();
        const skillNameFilter = (searchParams.get('skillName') || '').trim();
        const skillVersionRaw = searchParams.get('skillVersion');
        const skillVersionFilter = skillVersionRaw ? Number(skillVersionRaw) : null;

        const where: Record<string, unknown> = { user };

        // 需要过滤(autoWatch / 排除灰度)时多抓些 group, 过滤后再分页, 避免一页被过滤到几乎为空。
        const overFetch = autoWatchOnly || excludeGrayscale || Boolean(scope);
        const groupLimit = scope
            ? Math.max(limit * 20, 500)
            : overFetch ? Math.max(limit * 8, 50) : limit + 1;
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
                    skill: true,
                    skillVersion: true,
                },
            })
            : [];
        const executionAgentByKey = new Map<string, string>();
        // execKey → "skillName skillVersion"，用于把每个评测任务归到 skill+版本（前端按当前 skill 筛选历史任务）。
        const executionSkillByKey = new Map<string, { skill: string; version: number | null }>();
        for (const execution of executions) {
            const agentName = String(execution.agentName || '').trim();
            if (agentName) {
                executionAgentByKey.set(execution.id, agentName);
                if (execution.taskId) executionAgentByKey.set(execution.taskId, agentName);
            }
            const skillName = String(execution.skill || '').trim();
            if (skillName) {
                const version = typeof execution.skillVersion === 'number' ? execution.skillVersion : null;
                executionSkillByKey.set(execution.id, { skill: skillName, version });
                if (execution.taskId) executionSkillByKey.set(execution.taskId, { skill: skillName, version });
            }
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
                const agent = getPrimaryObservedAgentName(interactions);
                if (agent) executionAgentByKey.set(session.taskId, agent);
            } catch {
                /* ignore malformed session interactions */
            }
        }

        const summaries = candidateRunIds
            .map(runId => {
                const runRows = byRun.get(runId) || [];
                const allVisibleRows = runRows.filter(row => {
                    const raw = safeParse(row.rawAnalysisJson, {}) as { watchPlaceholder?: unknown };
                    return raw.watchPlaceholder !== true;
                });
                const visibleRows = latestByCase
                    ? selectLatestDatasetCaseResults(allVisibleRows)
                    : allVisibleRows;
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
                // 主导 skill+版本：按该任务内各 trace 关联 execution 的 skill/version 计数取最多的一组。
                const skillCounts = new Map<string, { skill: string; version: number | null; count: number }>();
                for (const row of visibleRows) {
                    const sk = executionSkillByKey.get(row.taskId || '') || executionSkillByKey.get(row.executionId || '');
                    if (!sk) continue;
                    const key = `${sk.skill} ${sk.version ?? ''}`;
                    const prevSkill = skillCounts.get(key);
                    if (prevSkill) prevSkill.count += 1;
                    else skillCounts.set(key, { skill: sk.skill, version: sk.version, count: 1 });
                }
                const topSkillEntry = Array.from(skillCounts.values()).sort((a, b) => b.count - a.count)[0] || null;
                const taskMeta = extractTrajectoryTaskMeta(first.rawAnalysisJson, new Date(earliest));
                const topSkillName = taskMeta.skillName || topSkillEntry?.skill || '';
                const topSkillVersion = taskMeta.skillVersion ?? topSkillEntry?.version ?? null;
                const doneRows = visibleRows.filter(row => getEffectiveStatus(row) === 'done');
                const scores = doneRows
                    .map(row => {
                        const raw = safeParse(row.rawAnalysisJson, {}) as { selectedEvaluators?: string[] };
                        const traceScore = hasSelectedEvaluator(raw, 'preset-agent-trace-quality') ? row.trajectoryScore : null;
                        const resultScore = hasSelectedEvaluator(raw, 'preset-agent-task-completion')
                            ? pickResultEvaluationScore(row.rawAnalysisJson)
                            : null;
                        const hasTraceEvaluator = hasSelectedEvaluator(raw, 'preset-agent-trace-quality');
                        const hasResultEvaluator = hasSelectedEvaluator(raw, 'preset-agent-task-completion');
                        if (hasTraceEvaluator && (typeof traceScore !== 'number' || Number.isNaN(traceScore))) return null;
                        if (hasResultEvaluator && (typeof resultScore !== 'number' || Number.isNaN(resultScore))) return null;
                        if (typeof traceScore === 'number' && typeof resultScore === 'number') return (traceScore + resultScore) / 2;
                        return traceScore ?? resultScore ?? null;
                    })
                    .filter((score): score is number => typeof score === 'number');
                return {
                    runId,
                    datasetId: first.datasetId,
                    taskTitle: taskMeta.title,
                    taskDescription: taskMeta.description,
                    taskScope: taskMeta.scope || '',
                    evaluatorIds: getEvaluatorIds(runRows),
                    executionAgent: topAgent || (typeof firstRaw.watchedAgent === 'string' ? firstRaw.watchedAgent : ''),
                    skillName: topSkillName,
                    skillVersion: topSkillVersion,
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
                    // 来源标记: 任一 trace 带 grayscaleBinding 即为灰度 A/B 的评测批次。
                    source: runRows.some(row => {
                        const raw = safeParse(row.rawAnalysisJson, {}) as { grayscaleBinding?: unknown };
                        return raw.grayscaleBinding != null;
                    }) ? 'grayscale-ab' : 'standalone',
                };
            })
            .filter((item): item is NonNullable<typeof item> => Boolean(item))
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        // 用例分析: 彻底排除灰度 A/B 的评测批次(它们只在 A/B 页查看), 不对 includeRunId 网开一面 ——
        // 否则用例分析里若残留一个指向 A/B 批次的选择(traceEvaluationBatchId), 那条会被锚定保留下来。
        const visible = excludeGrayscale ? summaries.filter(item => item.source !== 'grayscale-ab') : summaries;
        const scopedVisible = scope
            ? visible.filter(item => {
                if (item.taskScope !== scope) return false;
                if (scope === 'skill-case-analysis') {
                    if (!skillNameFilter || item.skillName !== skillNameFilter) return false;
                    if (
                        skillVersionRaw
                        && Number.isFinite(skillVersionFilter)
                        && item.skillVersion !== skillVersionFilter
                    ) {
                        return false;
                    }
                }
                return true;
            })
            : visible;

        const normalPage = scopedVisible.slice(0, limit);
        const includedIndex = includeRunId
            ? scopedVisible.findIndex(summary => summary.runId === includeRunId)
            : -1;
        const anchorStart = includedIndex >= limit
            ? Math.max(0, Math.min(includedIndex - Math.floor(limit / 2), scopedVisible.length - limit))
            : 0;
        const page = includedIndex >= limit
            ? scopedVisible.slice(anchorStart, anchorStart + limit)
            : normalPage;
        const hasMore = scopedVisible.length > limit || (overFetch ? groups.length === groupLimit : groups.length > limit);
        const nextOffset = hasMore
            ? overFetch && scopedVisible.length <= limit
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
