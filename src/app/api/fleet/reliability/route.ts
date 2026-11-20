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

import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { readCoreAnalytics, analyticsFailure } from '@/lib/storage-core/analytics';


import { NextResponse } from 'next/server';
import { resolveTraceReadScope } from '@/lib/auth/admin';
import { bucketStarts, normalizeWindow, planOf } from '@/lib/fleet/agg';
import { aggregateFleetReliability, type ReliabilityEventRow, type ReliabilityExecutionRow } from '@/lib/fleet/reliability';
import { prisma } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

const TASK_ID_CHUNK = 400;

export async function GET(req: Request) {
    try {
        const url = new URL(req.url);
        const analytics = (await readCoreAnalytics(req));
        const executionReader = analytics ?? prisma.execution;
        const { username, user } = analytics ? {username: analytics.username, user: undefined} : await resolveTraceReadScope(req);
        if (!username) return NextResponse.json({ error: 'Missing user identity' }, { status: 401 });
        const window = normalizeWindow(url.searchParams.get('window'));
        const plan = planOf(window);
        const now = new Date();
        const starts = bucketStarts(now, plan);
        const from = new Date(starts[0]);
        const userFilter = analytics ? {} : user ? { user } : {};

        const rows = (await executionReader.findMany({
            where: { ...userFilter, isSubagent: false, timestamp: { gte: from } },
            select: {
                id: true, taskId: true, timestamp: true, framework: true, agentName: true, query: true,
                toolCallErrorCount: true, failures: true, callStats: true,
            },
        })) as ReliabilityExecutionRow[];
        const taskIds = [...new Set(rows.map((row) => row.taskId || row.id))];
        const eventBatches: ReliabilityEventRow[][] = [];
        if (analytics) eventBatches.push(analytics.events.filter(event => taskIds.includes(event.taskId)));
        for (let offset = 0; !analytics &&  offset < taskIds.length; offset += TASK_ID_CHUNK) {
            const chunk = taskIds.slice(offset, offset + TASK_ID_CHUNK);
            const events = await prisma.rasAnomalyEvent.findMany({
                where: {
                    taskId: { in: chunk },
                    ...(user ? { OR: [{ user }, { user: null }] } : {}),
                },
                orderBy: { ts: 'asc' },
                select: {
                    id: true, deliveryId: true, taskId: true, type: true, platform: true, framework: true,
                    anomalyKind: true, severity: true, summary: true, actionTypes: true, payloadJson: true, ts: true,
                },
            });
            eventBatches.push(events);
        }

        const data = aggregateFleetReliability({
            rows,
            events: eventBatches.flat(),
            starts,
            plan,
            platform: url.searchParams.get('platform'),
            agent: url.searchParams.get('agent'),
        });
        if (analytics) await analytics.validate();
        return NextResponse.json({ window, granularity: plan.gran, ...data });
    } catch (error) {
        return analyticsFailure(error);
    }
}
