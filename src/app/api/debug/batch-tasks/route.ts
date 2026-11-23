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
import type {BatchEvalTask} from '@prisma/client';
import { prisma } from '@/lib/storage/prisma';
import { visibleExperimentTask } from '@/lib/engine/experiment/task-visibility';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import {isStorageCoreEnabled} from '@/lib/storage-core/mode';
import {getCoreExperimentContext,coreExperimentFailure} from '@/lib/storage-core/experiments';
import {withCoreWorkbenchRoute} from '@/lib/storage-core/workbench';
import {projectCoreBatchTask,assertCoreBatchScope} from '@/lib/storage-core/batch-trace';

export async function GET(req: NextRequest): Promise<Response> {
    if(isStorageCoreEnabled()&&!getCoreExperimentContext()?.compatibilityRoute)return withCoreWorkbenchRoute(req,normalized=>GET(normalized));
    const { searchParams } = new URL(req.url);
    const user = searchParams.get('user');

    if (!user) {
        return NextResponse.json({ error: 'User is required' }, { status: 400 });
    }

    try {
        await assertCoreBatchScope('read');
        const tasks = await prisma.batchEvalTask.findMany({
            where: { user },
            orderBy: { createdAt: 'desc' },
            take: 50,
        });
        const parsed = tasks.map((t: BatchEvalTask) => ({
            ...t,
            configJson: JSON.parse(t.configJson || '{}'),
            caseStatesJson: JSON.parse(t.caseStatesJson || '{}'),
            traceEvalStatesJson: JSON.parse(t.traceEvalStatesJson || '{}'),
        }));
        return NextResponse.json((await Promise.all(parsed.map((projectCoreBatchTask)))).filter(Boolean));
    } catch (err) {
        console.error('[BATCH_TASKS_GET] Failed:', err);
        return coreExperimentFailure(err);
    }
}

export async function POST(req: NextRequest): Promise<Response> {
    if(isStorageCoreEnabled()&&!getCoreExperimentContext()?.compatibilityRoute)return withCoreWorkbenchRoute(req,normalized=>POST(normalized));
    try {
        const body = await req.json();
        const { user, taskName } = body;

        if (!user || !taskName?.trim()) {
            return NextResponse.json({ error: 'user and taskName are required' }, { status: 400 });
        }

        await assertCoreBatchScope('create');
        const task = await prisma.batchEvalTask.create({
            data: { user, taskName: taskName.trim() },
        });

        recordUsageEvent({ user, featureKey: 'skill-eval', eventKey: 'skill.eval.case.run' });

        return NextResponse.json(task);
    } catch (err) {
        console.error('[BATCH_TASKS_POST] Failed:', err);
        return coreExperimentFailure(err);
    }
}
