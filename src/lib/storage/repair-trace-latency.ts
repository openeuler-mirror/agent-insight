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

import type { PrismaClient } from '@prisma/client';
import { deriveExecutionTiming } from '@/lib/engine/observability/execution-timing';
import { jiuwenLegacyLatencyCorrection } from '@/lib/engine/observability/jiuwen-latency';

type LatencyChange = { id: string; taskId: string; originalLatency: number | null; latencyMs: number };

export async function repairTraceLatency(
    client: PrismaClient,
    options: {
        apply?: boolean;
        taskIds?: string[];
        framework?: 'opencode' | 'jiuwenswarm';
        audit?: (event: LatencyChange & { type: 'planned' | 'applied' }) => void;
    } = {},
) {
    const counts = { scanned: 0, changed: 0, updated: 0, skipped: 0, conflicts: 0 };
    const changes: LatencyChange[] = [];
    const framework = options.framework ?? 'opencode';
    let cursor: string | undefined;
    for (;;) {
        const rows = await client.execution.findMany({
            where: {
                framework,
                ...(cursor ? { id: { gt: cursor } } : {}),
                ...(options.taskIds?.length ? { taskId: { in: options.taskIds } } : {}),
            },
            select: { id: true, taskId: true, latency: true, lastIngestedAt: true, timestamp: true },
            orderBy: { id: 'asc' }, take: 100,
        });
        if (!rows.length) break;
        cursor = rows[rows.length - 1].id;
        for (const row of rows) {
            counts.scanned++;
            if (!row.taskId) { counts.skipped++; continue; }
            const session = await client.session.findUnique({ where: { taskId: row.taskId }, select: { interactions: true } });
            let interactions: unknown;
            try { interactions = JSON.parse(session?.interactions || 'null'); } catch { /* Preserve unreadable records. */ }
            if (!Array.isArray(interactions)) { counts.skipped++; continue; }
            const latency = framework === 'jiuwenswarm'
                ? jiuwenLegacyLatencyCorrection(row.latency, interactions)?.latencyMs
                : deriveExecutionTiming(interactions, row.taskId).activeDurationMs;
            if (latency === undefined) { counts.skipped++; continue; }
            if (latency === row.latency) continue;
            counts.changed++;
            const change = { id: row.id, taskId: row.taskId, originalLatency: row.latency, latencyMs: latency };
            if (!options.apply) { options.audit?.({ type: 'planned', ...change }); changes.push(change); continue; }
            const updated = await client.$transaction(async tx => {
                const current = await tx.session.findUnique({ where: { taskId: row.taskId! }, select: { interactions: true } });
                if (current?.interactions !== session?.interactions) return 0;
                options.audit?.({ type: 'planned', ...change });
                // Do not overwrite metrics from a concurrent upload with this older snapshot.
                const result = await tx.execution.updateMany({
                    where: { id: row.id, taskId: row.taskId, framework, latency: row.latency, lastIngestedAt: row.lastIngestedAt, timestamp: row.timestamp },
                    data: { latency },
                });
                return result.count;
            });
            if (updated) { counts.updated++; changes.push(change); options.audit?.({ type: 'applied', ...change }); }
            else counts.conflicts++;
        }
    }
    return { ...counts, changes };
}
