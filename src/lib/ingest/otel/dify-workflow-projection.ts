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

import { prismaRaw } from '@/lib/storage/prisma';
import { composeDifyWorkflowTrace, difyExecutionKey, DIFY_TRACE_MEMBER_BYTES, DIFY_TRACE_PROJECTION_BYTES, type DifyTraceMember } from '@/lib/engine/observability/dify-workflow-trace';
import type { LangfuseTraceNode } from './adapters/langfuse-trace';

export async function loadDifyWorkflowProjection(user: string, taskId: string, nodes: LangfuseTraceNode[]) {
  if (process.env.DB_HOST) return null;
  const ids = [...new Set(nodes.filter(n => !n.dify?.trajectory && difyExecutionKey(n.dify)).map(n => n.dify!.nodeExecutionId!))];
  if (!user || !ids.length || !taskId.startsWith('dify:')) return null;
  const candidates = await prismaRaw.session.findMany({
    where: { user, taskId: { startsWith: 'dify:', not: taskId }, OR: ids.slice(0, 64).map(id => ({ langfuseTraceNodes: { contains: JSON.stringify(id) } })) },
    orderBy: [{ startTime: 'desc' }, { taskId: 'asc' }], take: 101,
    select: { taskId: true },
  });
  const executions = candidates.length ? await prismaRaw.execution.findMany({
    where: { user, framework: 'dify', taskId: { in: candidates.slice(0, 100).map(s => s.taskId) } }, select: { taskId: true },
  }) : [];
  const allowed = new Set(executions.map(e => e.taskId));
  const members: DifyTraceMember[] = [];
  let payloadBytes = 0;
  let budgetExceeded = false;
  for (const candidate of candidates.slice(0, 100)) {
    if (!allowed.has(candidate.taskId)) continue;
    const rows = await prismaRaw.$queryRaw<Array<{ taskId: string; user: string; payload: string | null; characters: number | bigint }>>`
      SELECT "taskId", "user", SUBSTR("langfuseTraceNodes", 1, ${DIFY_TRACE_MEMBER_BYTES + 1}) AS payload,
        LENGTH("langfuseTraceNodes") AS characters FROM "Session" WHERE "taskId" = ${candidate.taskId} AND "user" = ${user}
    `;
    const session = rows[0];
    if (!session) continue;
    const raw = session.payload || '[]';
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (Number(session.characters) > DIFY_TRACE_MEMBER_BYTES || bytes > DIFY_TRACE_MEMBER_BYTES || payloadBytes + bytes > DIFY_TRACE_PROJECTION_BYTES) {
      budgetExceeded = true; continue;
    }
    payloadBytes += bytes;
    try {
      const child = JSON.parse(raw);
      if (Array.isArray(child) && child.every(n => n && typeof n.traceId === 'string' && typeof n.spanId === 'string')) {
        members.push({ taskId: session.taskId, user: session.user!, nodes: child });
      }
    } catch {}
  }
  const projection = composeDifyWorkflowTrace(user, nodes, members);
  return { ...projection, truncated: projection.truncated || budgetExceeded || candidates.length > 100 || ids.length > 64 };
}
