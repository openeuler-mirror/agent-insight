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
