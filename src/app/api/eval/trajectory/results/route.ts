import { NextResponse } from 'next/server';
import { prismaRaw as prisma } from '@/lib/storage/prisma';
import { extractTrajectoryTaskMeta } from '@/lib/eval/trajectory-task-meta';
import { selectLatestDatasetCaseResults } from '@/lib/eval/latest-trajectory-results';
import { selectKeepIdsByTaskId } from '@/lib/storage/data-service';

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
    const candidates = [
        raw?.resultEvaluation?.score,
        raw?.score,
    ];
    for (const value of candidates) {
        if (typeof value === 'number' && !Number.isNaN(value)) return value;
    }
    return null;
}

function pickCustomEvaluations(rawAnalysisJson: string | null | undefined): unknown[] {
    const raw = safeParse(rawAnalysisJson, null) as { customEvaluations?: unknown } | null;
    const value = raw?.customEvaluations;
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
    return [];
}

function pickCustomEvaluationScore(rawAnalysisJson: string | null | undefined): number | null {
    const raw = safeParse(rawAnalysisJson, null) as { customEvaluationScore?: unknown } | null;
    const value = raw?.customEvaluationScore;
    return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

type TraceDisplaySource = 'snapshot' | 'execution' | 'missing';

type TraceExecutionDisplay = {
    id: string;
    taskId: string | null;
    query: string | null;
    finalResult: string | null;
    framework: string | null;
    model: string | null;
    agentName: string | null;
    timestamp: Date | string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function firstNonEmptyString(...values: unknown[]): string {
    for (const value of values) {
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed) return trimmed;
    }
    return '';
}

export function resolveTrajectoryTraceDisplay(
    rawAnalysis: Record<string, unknown> | null,
    execution?: TraceExecutionDisplay | null,
): {
    traceInput: string | null;
    traceInputSource: TraceDisplaySource;
    traceOutput: string | null;
    traceOutputSource: TraceDisplaySource;
} {
    const caseSnapshot = asRecord(rawAnalysis?.caseSnapshot);
    const snapshotInput = firstNonEmptyString(
        caseSnapshot?.taskInput,
        caseSnapshot?.rawTaskInput,
        caseSnapshot?.input,
    );
    const snapshotOutput = firstNonEmptyString(rawAnalysis?.resultActualOutput);
    const executionInput = firstNonEmptyString(execution?.query);
    const executionOutput = firstNonEmptyString(execution?.finalResult);

    return {
        traceInput: snapshotInput || executionInput || null,
        traceInputSource: snapshotInput ? 'snapshot' : executionInput ? 'execution' : 'missing',
        traceOutput: snapshotOutput || executionOutput || null,
        traceOutputSource: snapshotOutput ? 'snapshot' : executionOutput ? 'execution' : 'missing',
    };
}

async function loadExecutionDisplayByTraceId(rows: { taskId: string | null; executionId: string | null }[]): Promise<Map<string, TraceExecutionDisplay>> {
    const taskIds = Array.from(new Set(rows.map(row => row.taskId).filter((id): id is string => Boolean(id))));
    const executionIds = Array.from(new Set(rows.map(row => row.executionId).filter((id): id is string => Boolean(id))));
    if (taskIds.length === 0 && executionIds.length === 0) return new Map();

    const executionRows = await prisma.execution.findMany({
        where: {
            OR: [
                ...(taskIds.length > 0 ? [{ taskId: { in: taskIds } }] : []),
                ...(executionIds.length > 0 ? [{ id: { in: executionIds } }] : []),
            ],
        },
        select: {
            id: true,
            taskId: true,
            query: true,
            finalResult: true,
            framework: true,
            model: true,
            agentName: true,
            timestamp: true,
        },
    });

    const byTraceId = new Map<string, TraceExecutionDisplay>();
    const rowsWithTaskId = executionRows.filter(row => row.taskId);
    const { keepIds } = selectKeepIdsByTaskId(rowsWithTaskId);
    for (const row of executionRows) {
        const item: TraceExecutionDisplay = row;
        if (row.taskId && keepIds.has(row.id)) byTraceId.set(row.taskId, item);
        byTraceId.set(row.id, item);
    }
    return byTraceId;
}

/**
 * 删除评测记录：从「评测执行」列表移除一条记录。
 * 入参 { user, taskId, runId?, resultId? }：
 *  - resultId 指定 → 精确删该行；
 *  - 否则按 user + taskId (+ evaluatorRunId=runId) 删该 trace 在该评测任务下的全部记录。
 * 安全约束：若命中行里有 running / pending（评测/执行进行中），整体拒绝删除（409）。
 */
export async function DELETE(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        let body: Record<string, unknown> = {};
        try { body = await request.json(); } catch { /* 允许走 query 参数 */ }
        const pick = (k: string) => String((body[k] as string) ?? searchParams.get(k) ?? '').trim();
        const user = pick('user');
        const taskId = pick('taskId');
        const runId = pick('runId');
        const resultId = pick('resultId');
        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });
        if (!resultId && !taskId) {
            return NextResponse.json({ error: 'taskId or resultId is required' }, { status: 400 });
        }

        const where: Record<string, unknown> = { user };
        if (resultId) where.id = resultId;
        else {
            where.taskId = taskId;
            if (runId) where.evaluatorRunId = runId;
        }

        const rows = await prisma.trajectoryEvalResult.findMany({
            where,
            select: { id: true, status: true },
        });
        if (rows.length === 0) return NextResponse.json({ deleted: 0 });
        if (rows.some(r => r.status === 'running' || r.status === 'pending')) {
            return NextResponse.json(
                { error: '评测/执行进行中，无法删除；请等待完成或先中止后再删除。' },
                { status: 409 },
            );
        }
        const res = await prisma.trajectoryEvalResult.deleteMany({ where });
        return NextResponse.json({ deleted: res.count });
    } catch (e) {
        return NextResponse.json({ error: (e as Error)?.message || '删除失败' }, { status: 500 });
    }
}

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const user = (searchParams.get('user') || '').trim();
        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });

        const datasetId = (searchParams.get('datasetId') || '').trim();
        const executionId = (searchParams.get('executionId') || '').trim();
        const taskId = (searchParams.get('taskId') || '').trim();
        const evaluatorRunId = (searchParams.get('runId') || '').trim();
        const limit = Math.min(Number(searchParams.get('limit') || '100'), 500);
        const latestByCase = searchParams.get('latestByCase') === '1' || searchParams.get('latestByCase') === 'true';

        const where: Record<string, unknown> = { user };
        if (datasetId) where.datasetId = datasetId;
        if (executionId) where.executionId = executionId;
        if (taskId) where.taskId = taskId;
        if (evaluatorRunId) where.evaluatorRunId = evaluatorRunId;

        const rows = await prisma.trajectoryEvalResult.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: latestByCase ? 500 : limit,
        });
        const visibleRows = latestByCase
            ? selectLatestDatasetCaseResults(rows).slice(0, limit)
            : rows;
        const executionByTraceId = await loadExecutionDisplayByTraceId(visibleRows);

        const results = visibleRows.map(r => {
            const rawAnalysis = safeParse(r.rawAnalysisJson, null) as Record<string, unknown> | null;
            const traceId = r.taskId || r.executionId || '';
            const executionDisplay = traceId ? executionByTraceId.get(traceId) : null;
            const traceDisplay = resolveTrajectoryTraceDisplay(rawAnalysis, executionDisplay);
            const rawMeta = (rawAnalysis || {}) as {
                selectedEvaluators?: string[];
                selectedEvaluatorNames?: string[];
                autoWatch?: boolean;
                watchedAgent?: string;
                watchPlaceholder?: boolean;
            };
            return {
            ...rawMeta,
            ...(() => {
                const taskMeta = extractTrajectoryTaskMeta(r.rawAnalysisJson, r.createdAt);
                return {
                    taskTitle: taskMeta.title,
                    taskDescription: taskMeta.description,
                };
            })(),
            id: r.id,
            evaluatorRunId: r.evaluatorRunId,
            datasetId: r.datasetId,
            caseId: r.caseId,
            executionId: r.executionId,
            taskId: r.taskId,
            status: r.status,
            errorMessage: r.errorMessage,
            trajectoryScore: r.trajectoryScore,
            dimensionScores: safeParse(r.dimensionScoresJson, null),
            deviationSteps: safeParse(r.deviationStepsJson, []),
            rootCauseStep: r.rootCauseStep,
            reasonText: r.reasonText,
            resultEvaluationScore: pickResultEvaluationScore(r.rawAnalysisJson),
            customEvaluationScore: pickCustomEvaluationScore(r.rawAnalysisJson),
            customEvaluations: pickCustomEvaluations(r.rawAnalysisJson),
            diagnostic: rawAnalysis?.diagnostic ?? null,
            rawAnalysis,
            ...traceDisplay,
            traceFramework: executionDisplay?.framework ?? null,
            traceModel: executionDisplay?.model ?? null,
            traceAgentName: executionDisplay?.agentName ?? null,
            traceTimestamp: executionDisplay?.timestamp instanceof Date
                ? executionDisplay.timestamp.toISOString()
                : executionDisplay?.timestamp ?? null,
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
            };
        });

        return NextResponse.json({ results });
    } catch (error: unknown) {
        console.error('trajectory/results GET error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'failed to load results' },
            { status: 500 },
        );
    }
}
