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
import { withCoreExperiments, requireCoreExperimentContext, coreExperimentFailure } from '@/lib/storage-core/experiments';
import { resolveUser } from '@/lib/auth/auth';
import { isLlmScoredGenerator } from '@/lib/engine/skill-issues/static-evaluator';
import { prismaRaw } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Evaluation 详情：用于 /evaluation/<id> 详情页。
 * 单 query 拉 Evaluation + 关联 SkillIssue 列表（按 severity 排序）+ Skill 名 + dynamic 的 Execution 摘要。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const core = isStorageCoreEnabled();
    const { username } = core ? { username: null } : await resolveUser(request);

    const evaluation = core
      ? await withCoreExperiments(request, async () => {
          const actor=requireCoreExperimentContext().actor.username;
          const staticEvaluation=await prismaRaw.evaluation.findFirst({
            where:{id,type:'static',executionId:null,OR:[{user:actor},{user:null}],Skill:{OR:[{user:actor},{user:null},{visibility:'public'}]}},
            include:{Skill:{select:{id:true,name:true,user:true}},issues:{where:{source:'static',OR:[{user:actor},{user:null}]},orderBy:{createdAt:'asc'}}},
          });
          if(staticEvaluation)return {...staticEvaluation,Execution:null};
          const detail = await requireCoreExperimentContext().rpc('derived_detail', { id }) as { evaluation: Record<string, unknown>; issues: unknown[]; skill: unknown; execution: unknown };
          return { ...detail.evaluation, issues: detail.issues, Skill: detail.skill, Execution: detail.execution };
        }) as Awaited<ReturnType<typeof loadLegacyEvaluation>>
      : await loadLegacyEvaluation(id);

    return evaluationResponse(evaluation, username, core);
  } catch (e: any) {
    if (isStorageCoreEnabled()) return coreExperimentFailure(e);
    console.error('[Evaluation Detail] error:', e);
    return NextResponse.json({ error: e?.message || 'fetch failed' }, { status: 500 });
  }
}

async function loadLegacyEvaluation(id: string) {
  return prismaRaw.evaluation.findUnique({
      where: { id },
      include: {
        Skill: { select: { id: true, name: true, user: true } },
        Execution: { select: { id: true, taskId: true, query: true, model: true, framework: true, timestamp: true } },
        issues: {
          orderBy: [{ createdAt: 'asc' }],
        },
      },
    });
}

function evaluationResponse(evaluation: Awaited<ReturnType<typeof loadLegacyEvaluation>>, username: string | null, core: boolean) {
    if (!evaluation) {
      return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    }

    if (!core && evaluation.user && username && evaluation.user !== username) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
    const issues = [...evaluation.issues].sort((a, b) => {
      const r = (severityRank[a.severity] ?? 99) - (severityRank[b.severity] ?? 99);
      if (r !== 0) return r;
      return (a.dimension || '').localeCompare(b.dimension || '');
    });

    const histogram = { high: 0, medium: 0, low: 0 };
    for (const i of issues) {
      if (i.severity === 'high') histogram.high++;
      else if (i.severity === 'medium') histogram.medium++;
      else if (i.severity === 'low') histogram.low++;
    }

    // l2ScoresJson 只由静态评估器写入；纯 L1 generator（无 +llm）的历史行可能残留
    // L1 floor 分数——L1 不单独评分，这类分数不下发给前端。
    let l2Scores: any = null;
    if (evaluation.l2ScoresJson && isLlmScoredGenerator(evaluation.generator)) {
      try { l2Scores = JSON.parse(evaluation.l2ScoresJson); } catch { l2Scores = null; }
    }

    return NextResponse.json({
      evaluation: {
        id: evaluation.id,
        type: evaluation.type,
        skillId: evaluation.skillId,
        skillName: evaluation.Skill?.name ?? null,
        version: evaluation.version,
        user: evaluation.user,
        executionId: evaluation.executionId,
        contentHash: evaluation.contentHash,
        ranAt: evaluation.ranAt,
        status: evaluation.status,
        errorMessage: evaluation.errorMessage,
        durationMs: evaluation.durationMs,
        generator: evaluation.generator,
        l2Scores,
      },
      execution: evaluation.Execution
        ? {
            id: evaluation.Execution.id,
            taskId: evaluation.Execution.taskId,
            query: evaluation.Execution.query,
            model: evaluation.Execution.model,
            framework: evaluation.Execution.framework,
            timestamp: evaluation.Execution.timestamp,
          }
        : null,
      issues,
      histogram,
    });
}
