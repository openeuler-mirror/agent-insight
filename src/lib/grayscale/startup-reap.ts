import { reconcileStaleGrayscaleRun } from '@/lib/grayscale/stale-run-reconcile';
import { prisma } from '@/lib/storage/prisma';

type CaseStatus = 'pending' | 'running' | 'executed' | 'evaluating' | 'pass' | 'fail';

type RunState = {
    status: CaseStatus;
    sessionId?: string;
    failureType?: string;
    failureDetail?: string;
    output?: string;
    score?: number;
    evaluations?: Array<{ status: string; errorMessage?: string; evaluatorId?: string }>;
    evaluationClaimId?: string;
    evaluationResultId?: string;
    evaluatorRunId?: string;
    evalRetryPending?: boolean;
    timeCost?: string;
    tokenUsage?: number;
    toolCallCount?: number;
    toolCalls?: string[];
    skillTriggered?: boolean;
};

type SideState = {
    status: CaseStatus;
    runs?: RunState[];
    runCount?: number;
    timeCost?: string;
    tokenUsage?: number;
    output?: string;
    sessionId?: string;
    traceIds?: string[];
    score?: number;
    tier?: 'good' | 'warn' | 'poor';
    skillTriggered?: boolean;
    toolCallCount?: number;
    toolCalls?: string[];
};

type CaseStates = Record<string, { a: SideState; b: SideState }>;

function rebuildSideAggregate(state: SideState, totalRuns: number): SideState {
    const runs = state.runs || [];
    const expectedRuns = Math.max(0, Number(totalRuns) || 0);
    const aggregateRuns = expectedRuns > 0 && runs.length > expectedRuns ? runs.slice(-expectedRuns) : runs;
    const effectiveTotalRuns = expectedRuns || aggregateRuns.length;
    const finished = aggregateRuns.filter(run => run.status === 'executed' || run.status === 'pass');
    const executionFinished = aggregateRuns.filter(run => (
        run.status === 'executed'
        || run.status === 'evaluating'
        || run.status === 'pass'
        || (run.status === 'fail' && Boolean(run.sessionId))
    ));
    const failed = aggregateRuns.filter(run => run.status === 'fail');
    const evaluating = aggregateRuns.some(run => run.status === 'evaluating');
    const running = aggregateRuns.some(run => run.status === 'running' || run.status === 'pending');
    const scored = aggregateRuns.filter(run => typeof run.score === 'number');
    const seconds = executionFinished
        .map(run => typeof run.timeCost === 'string' ? Number.parseFloat(run.timeCost) : 0)
        .filter(value => Number.isFinite(value) && value > 0);
    const avgSeconds = seconds.length ? seconds.reduce((sum, value) => sum + value, 0) / seconds.length : 0;
    const tokenRuns = executionFinished.filter(run => typeof run.tokenUsage === 'number');
    const avgTokens = tokenRuns.length
        ? Math.round(tokenRuns.reduce((sum, run) => sum + (run.tokenUsage || 0), 0) / tokenRuns.length)
        : 0;
    const avgScore = scored.length
        ? Math.round(scored.reduce((sum, run) => sum + (run.score || 0), 0) / scored.length)
        : undefined;
    const traceIds = executionFinished.map(run => run.sessionId).filter(Boolean) as string[];

    let status: CaseStatus = 'pending';
    if (scored.length >= effectiveTotalRuns && effectiveTotalRuns > 0) status = 'pass';
    else if (failed.length >= effectiveTotalRuns && effectiveTotalRuns > 0) status = 'fail';
    else if (finished.length + failed.length >= effectiveTotalRuns && effectiveTotalRuns > 0) status = 'executed';
    else if (evaluating) status = 'evaluating';
    else if (running || finished.length > 0) status = 'running';

    return {
        ...state,
        status,
        runs,
        runCount: totalRuns,
        timeCost: seconds.length ? `${avgSeconds.toFixed(1)}s` : undefined,
        tokenUsage: avgTokens || undefined,
        output: [...executionFinished].reverse()[0]?.output || state.output,
        sessionId: traceIds[0] || state.sessionId,
        traceIds,
        score: avgScore,
        tier: avgScore == null ? undefined : avgScore >= 80 ? 'good' : avgScore >= 50 ? 'warn' : 'poor',
        skillTriggered: executionFinished.some(run => run.skillTriggered),
        toolCallCount: executionFinished.reduce((sum, run) => sum + (run.toolCallCount || 0), 0),
        toolCalls: Array.from(new Set(executionFinished.flatMap(run => run.toolCalls || []))).slice(0, 8),
    };
}

export async function reapStaleGrayscaleRunsAtStartup(): Promise<number> {
    const cancelable: CaseStatus[] = ['running', 'evaluating', 'pending'];
    const reason = '服务重启中断（启动回收）';
    let tasks: Array<{ id: string; user: string; caseStatesJson: string }>;
    try {
        tasks = await (prisma as unknown as {
            grayscaleTask: { findMany: (args: unknown) => Promise<Array<{ id: string; user: string; caseStatesJson: string }>> };
        }).grayscaleTask.findMany({ select: { id: true, user: true, caseStatesJson: true } });
    } catch {
        return 0;
    }
    let patchedTasks = 0;
    for (const task of tasks) {
        let states: CaseStates;
        try { states = JSON.parse(task.caseStatesJson || '{}') as CaseStates; } catch { continue; }
        let changed = false;
        for (const caseId of Object.keys(states)) {
            for (const side of ['a', 'b'] as const) {
                const sideState = states[caseId]?.[side];
                if (!sideState) continue;
                let patched = false;
                for (const run of sideState.runs || []) {
                    if (reconcileStaleGrayscaleRun(run, reason)) {
                        patched = true;
                        changed = true;
                    }
                }
                if (patched) {
                    states[caseId][side] = rebuildSideAggregate(
                        sideState,
                        sideState.runCount || sideState.runs?.length || 0,
                    );
                    const rebuilt = states[caseId][side];
                    if (cancelable.includes(rebuilt.status)) {
                        rebuilt.status = 'fail';
                        rebuilt.output = rebuilt.output || '服务重启中断';
                    }
                }
            }
        }
        if (changed) {
            try {
                await (prisma as unknown as {
                    grayscaleTask: { updateMany: (args: unknown) => Promise<unknown> };
                }).grayscaleTask.updateMany({
                    where: { id: task.id, user: task.user },
                    data: { caseStatesJson: JSON.stringify(states) },
                });
                patchedTasks += 1;
            } catch {}
        }
    }
    return patchedTasks;
}
