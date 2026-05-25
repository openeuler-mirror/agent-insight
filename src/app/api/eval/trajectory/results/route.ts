import { NextResponse } from 'next/server';
import { prismaRaw as prisma } from '@/lib/storage/prisma';
import { extractTrajectoryTaskMeta } from '@/lib/eval/trajectory-task-meta';

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

        const where: Record<string, unknown> = { user };
        if (datasetId) where.datasetId = datasetId;
        if (executionId) where.executionId = executionId;
        if (taskId) where.taskId = taskId;
        if (evaluatorRunId) where.evaluatorRunId = evaluatorRunId;

        const rows = await prisma.trajectoryEvalResult.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: limit,
        });

        const results = rows.map(r => ({
            ...(safeParse(r.rawAnalysisJson, {}) as {
                selectedEvaluators?: string[];
                selectedEvaluatorNames?: string[];
                autoWatch?: boolean;
                watchedAgent?: string;
                watchPlaceholder?: boolean;
            }),
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
            rawAnalysis: safeParse(r.rawAnalysisJson, null),
            createdAt: r.createdAt.toISOString(),
            updatedAt: r.updatedAt.toISOString(),
        }));

        return NextResponse.json({ results });
    } catch (error: unknown) {
        console.error('trajectory/results GET error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'failed to load results' },
            { status: 500 },
        );
    }
}
