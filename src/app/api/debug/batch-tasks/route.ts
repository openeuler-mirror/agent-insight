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

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { visibleExperimentTask } from '@/lib/engine/experiment/task-visibility';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

export async function GET(req: NextRequest) {
    const { searchParams } = new URL(req.url);
    const user = searchParams.get('user');

    if (!user) {
        return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }

    try {
        const tasks = await (prisma as any).batchEvalTask.findMany({
            where: { user },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        const parsed = tasks.map((t: any) => ({
            ...t,
            configJson: JSON.parse(t.configJson || '{}'),
            caseStatesJson: JSON.parse(t.caseStatesJson || '{}'),
            traceEvalStatesJson: JSON.parse(t.traceEvalStatesJson || '{}'),
        }));
        return NextResponse.json((await Promise.all(parsed.map(visibleExperimentTask))).filter(Boolean));
    } catch (err) {
        console.error('[BATCH_TASKS_GET] Failed:', err);
        return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();
        const { user, taskName } = body;

        if (!user || !taskName?.trim()) {
            return NextResponse.json({ error: 'user and taskName are required' }, { status: 400 });
        }

        const task = await (prisma as any).batchEvalTask.create({
            data: { user, taskName: taskName.trim() },
        });

        recordUsageEvent({ user, featureKey: 'skill-eval', eventKey: 'skill.eval.case.run' });

        return NextResponse.json(task);
    } catch (err) {
        console.error('[BATCH_TASKS_POST] Failed:', err);
        return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }
}
