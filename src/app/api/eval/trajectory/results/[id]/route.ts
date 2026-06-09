import { NextResponse } from 'next/server';
import { prismaRaw as prisma } from '@/lib/storage/prisma';
import { extractTrajectoryTaskMeta } from '@/lib/eval/trajectory-task-meta';
import { summarizeTrace } from '@/lib/engine/evaluation/trace-summarizer';
import { normalizeTrajectoryRedundancyDetails } from '@/lib/engine/evaluation/trajectory-evaluator';

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

async function normalizeRawAnalysisForDisplay(
    rawAnalysis: Record<string, unknown> | null,
    taskId: string | null,
): Promise<Record<string, unknown> | null> {
    if (!rawAnalysis || !taskId) return rawAnalysis;
    try {
        const session = await prisma.session.findUnique({ where: { taskId } });
        const interactions = safeParse(session?.interactions, []);
        if (!Array.isArray(interactions) || interactions.length === 0) return rawAnalysis;
        const summary = summarizeTrace(interactions, { maxSteps: 80, maxTextLen: 400 });
        return normalizeTrajectoryRedundancyDetails(rawAnalysis, summary.steps);
    } catch (error) {
        console.warn('[trajectory/results detail] failed to normalize redundancy details:', (error as Error)?.message || error);
        return rawAnalysis;
    }
}

export async function GET(
    request: Request,
    context: { params: Promise<{ id: string }> },
) {
    try {
        const { id } = await context.params;
        const { searchParams } = new URL(request.url);
        const user = (searchParams.get('user') || '').trim();
        if (!user) return NextResponse.json({ error: 'user is required' }, { status: 400 });

        const row = await prisma.trajectoryEvalResult.findUnique({ where: { id } });
        if (!row || row.user !== user) {
            return NextResponse.json({ error: 'not found' }, { status: 404 });
        }
        const taskMeta = extractTrajectoryTaskMeta(row.rawAnalysisJson, row.createdAt);
        const parsedRawAnalysis = safeParse(row.rawAnalysisJson, null) as Record<string, unknown> | null;
        const rawAnalysis = await normalizeRawAnalysisForDisplay(parsedRawAnalysis, row.taskId);
        const rawMeta = (rawAnalysis || {}) as { selectedEvaluators?: string[]; selectedEvaluatorNames?: string[] };

        return NextResponse.json({
            ...rawMeta,
            taskTitle: taskMeta.title,
            taskDescription: taskMeta.description,
            id: row.id,
            evaluatorRunId: row.evaluatorRunId,
            datasetId: row.datasetId,
            caseId: row.caseId,
            executionId: row.executionId,
            taskId: row.taskId,
            status: row.status,
            errorMessage: row.errorMessage,
            trajectoryScore: row.trajectoryScore,
            dimensionScores: safeParse(row.dimensionScoresJson, null),
            deviationSteps: safeParse(row.deviationStepsJson, []),
            rootCauseStep: row.rootCauseStep,
            reasonText: row.reasonText,
            resultEvaluationScore: pickResultEvaluationScore(row.rawAnalysisJson),
            customEvaluationScore: pickCustomEvaluationScore(row.rawAnalysisJson),
            customEvaluations: pickCustomEvaluations(row.rawAnalysisJson),
            diagnostic: rawAnalysis?.diagnostic ?? null,
            rawAnalysis,
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        });
    } catch (error: unknown) {
        console.error('trajectory/results/[id] GET error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'failed to load result' },
            { status: 500 },
        );
    }
}
