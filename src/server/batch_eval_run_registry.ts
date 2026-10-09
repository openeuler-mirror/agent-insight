import { prisma } from '@/lib/storage/prisma';

type ActiveBatchRun = {
    abortController: AbortController;
    startedAt: number;
    user: string;
};

type BatchCaseState = {
    status?: string;
    error?: string;
    completedAt?: number;
    [key: string]: unknown;
};

export const batchActiveRuns = new Map<string, ActiveBatchRun>();

async function resetStuckCases(taskId: string, user: string): Promise<number> {
    const task = await (prisma as unknown as {
        batchEvalTask: {
            findFirst: (args: unknown) => Promise<{ caseStatesJson: string } | null>;
            update: (args: unknown) => Promise<unknown>;
        };
    }).batchEvalTask.findFirst({ where: { id: taskId, user } });
    if (!task) return 0;

    let states: Record<string, BatchCaseState>;
    try {
        states = JSON.parse(task.caseStatesJson || '{}');
    } catch {
        return 0;
    }

    let resetCases = 0;
    for (const key of Object.keys(states)) {
        const state = states[key];
        if (state && ['running', 'evaluating', 'executed'].includes(String(state.status))) {
            states[key] = { ...state, status: 'fail', error: '已手动终止', completedAt: Date.now() };
            resetCases += 1;
        }
    }
    if (resetCases > 0) {
        await (prisma as unknown as {
            batchEvalTask: { update: (args: unknown) => Promise<unknown> };
        }).batchEvalTask.update({
            where: { id: taskId, user },
            data: { caseStatesJson: JSON.stringify(states) },
        });
    }
    return resetCases;
}

export async function abortBatchRunsForUser(user: string): Promise<{ abortedRuns: number; resetCases: number }> {
    if (!user) return { abortedRuns: 0, resetCases: 0 };
    let abortedRuns = 0;
    let resetCases = 0;
    const taskIds: string[] = [];
    for (const [taskId, entry] of batchActiveRuns) {
        if (entry.user !== user) continue;
        try { entry.abortController.abort(); } catch {}
        batchActiveRuns.delete(taskId);
        abortedRuns += 1;
        taskIds.push(taskId);
    }
    for (const taskId of taskIds) {
        try { resetCases += await resetStuckCases(taskId, user); } catch {}
    }
    return { abortedRuns, resetCases };
}
