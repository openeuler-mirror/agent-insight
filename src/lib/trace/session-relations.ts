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

import { sqlDatabase } from '@/lib/collaboration/store';
import type { DatabaseAdapter } from '@/lib/storage/db-interface';
import type { CollaborationProjectionPlan } from '@/lib/collaboration/projection';
import type { ParentAgentReference, TraceRelations } from './parent-agent';

export async function sessionTraceRelations(
    db: Pick<DatabaseAdapter, 'findExecutions' | 'getClient'>, user: string, taskIds: string[], plan: CollaborationProjectionPlan,
): Promise<TraceRelations> {
    const relations: TraceRelations = Object.create(null);
    for (const id of new Set(taskIds)) {
        const unavailable = plan.unavailable || plan.parentAgents?.[id]?.state === 'unavailable';
        relations[id] = {
            parent: plan.parentAgents?.[id] ?? (unavailable ? { state: 'unavailable' } : null),
            children: [...(plan.childAgents?.[id] ?? [])],
            ...(unavailable ? { unavailable: true } : {}),
        };
    }
    const select = { id: true, taskId: true, parentExecutionId: true, agentName: true, subagentName: true, framework: true, latency: true, tokens: true };
    try {
        const current = await db.findExecutions({ user, taskId: { in: taskIds } }, undefined, select);
        const parentIds = current.flatMap(item => item.parentExecutionId ? [item.parentExecutionId] : []);
        const [parents, children] = await Promise.all([
            parentIds.length ? db.findExecutions({ user, id: { in: parentIds } }, undefined, select) : [],
            current.length ? db.findExecutions({ user, parentExecutionId: { in: current.map(item => item.id) } }, undefined, select) : [],
        ]);
        const readable = new Set<string>();
        const targets = [...new Set<string>([...parents, ...children].flatMap(row => row.taskId ? [row.taskId] : []))];
        for (let offset = 0; offset < targets.length; offset += 200) {
            const batch = targets.slice(offset, offset + 200);
            const sessions = await sqlDatabase(db.getClient()).rows<{ taskId: string }>(
                `SELECT "taskId" FROM "Session" WHERE "user"=? AND "taskId" IN (${batch.map(() => '?').join(',')})`, [user, ...batch]);
            sessions.forEach(session => readable.add(session.taskId));
        }
        const reference = (row: typeof current[number]): ParentAgentReference => row.taskId && readable.has(row.taskId) ? {
            state: 'resolved', taskId: row.taskId, executionId: row.id,
            agentName: row.agentName || row.subagentName || row.framework || 'Agent', framework: row.framework,
            ...(row.latency != null || row.tokens != null ? { stats: {
                ...(row.latency != null ? { durationMs: Number(row.latency) } : {}),
                ...(row.tokens != null ? { totalTokens: Number(row.tokens) } : {}),
            } } : {}),
        } : { state: 'pending' };
        for (const id of taskIds) {
            const executions = current.filter(item => item.taskId === id);
            if (executions.length !== 1) continue;
            const execution = executions[0];
            const relation = relations[id];
            if (execution.parentExecutionId && !relation.parent) {
                const parent = parents.find(item => item.id === execution.parentExecutionId);
                relation.parent = parent ? reference(parent) : { state: 'pending' };
            }
            for (const child of children.filter(item => item.parentExecutionId === execution.id)) {
                if (relation.children.some(item => item.state === 'resolved' && item.taskId === child.taskId)) continue;
                relation.children.push(reference(child));
            }
        }
    } catch {
        for (const relation of Object.values(relations)) {
            relation.parent ??= { state: 'unavailable' };
            relation.unavailable = true;
        }
    }
    return relations;
}
