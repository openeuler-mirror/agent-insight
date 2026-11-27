/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { prismaRaw } from '@/lib/storage/prisma';
import { analyzeExperimentAssetVersions } from '@/lib/evaluation-assets/experiment-analysis';
import { assertVersionBackend } from '@/lib/evaluation-assets/service';
import { EvaluationAssetError } from '@/lib/evaluation-assets/types';

export const dynamic = 'force-dynamic';
const LIMIT = 1000;

export async function GET(request: Request) {
  try {
    const { username } = await resolveUser(request);
    if (!username) return NextResponse.json({ error: '请登录后查看实验资产版本分析' }, { status: 401 });
    assertVersionBackend();
    const rows = await prismaRaw.experiment.findMany({
      where: { user: username, deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIMIT + 1,
      select: {
        id: true, name: true, status: true, type: true, agentName: true, skillName: true, skillVersion: true,
        scope: true, preset: true, skillContextJson: true, createdAt: true,
        evaluatorIdsJson: true, evaluatorConfigsJson: true, configSnapshotJson: true,
        cases: { where: { deletedAt: null }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: {
          input: true, executionId: true, taskId: true, datasetInput: true, referenceOutput: true, caseValuesJson: true,
          evaluatorContextJson: true, faultInjectionType: true, groupId: true,
          traceAttempts: { where: { status: 'ready' }, orderBy: { attemptNo: 'desc' }, take: 1,
            select: { traceId: true, workerId: true, platform: true, agent: true, model: true, timeoutSeconds: true } },
          results: { select: { evaluatorId: true, status: true, score: true, humanScore: true } },
        } },
      },
    });
    const visible = rows.slice(0, LIMIT);
    const executionIds = [...new Set(visible.flatMap(row => row.cases.map(item => item.executionId).filter((id): id is string => Boolean(id))))];
    const taskIds = [...new Set(visible.flatMap(row => row.cases.filter(item => !item.executionId).map(item => item.taskId).filter((id): id is string => Boolean(id))))];
    const select = { id: true, taskId: true, model: true, framework: true, clientId: true } as const;
    type Execution = Awaited<ReturnType<typeof prismaRaw.execution.findMany<{ select: typeof select }>>>[number];
    const byId = new Map<string, Execution>(), byTask = new Map<string, Execution>();
    for (const [ids, field] of [[executionIds, 'id'], [taskIds, 'taskId']] as const) {
      for (let start = 0; start < ids.length; start += 400) {
        const executions = await prismaRaw.execution.findMany({ where: { user: username, [field]: { in: ids.slice(start, start + 400) } },
          orderBy: [{ timestamp: 'desc' }, { id: 'desc' }], select });
        for (const execution of executions) {
          byId.set(execution.id, execution);
          if (execution.taskId && !byTask.has(execution.taskId)) byTask.set(execution.taskId, execution);
        }
      }
    }
    const analyzed = visible.map(row => ({ ...row, cases: row.cases.map(item => {
      const execution = item.executionId ? byId.get(item.executionId) : item.taskId ? byTask.get(item.taskId) : undefined;
      const bindings = [item.executionId, item.taskId, execution?.id, execution?.taskId].filter(Boolean);
      const attempt = item.traceAttempts.find(candidate => candidate.traceId && bindings.includes(candidate.traceId));
      return { ...item, execution: execution || null, boundAttempt: attempt || null };
    }) }));
    return NextResponse.json({
      ...analyzeExperimentAssetVersions(analyzed),
      meta: { limit: LIMIT, returned: Math.min(rows.length, LIMIT), truncated: rows.length > LIMIT },
    });
  } catch (error) {
    if (error instanceof EvaluationAssetError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    return NextResponse.json({ error: '读取实验资产版本分析失败' }, { status: 500 });
  }
}
