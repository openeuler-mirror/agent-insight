import { resolveUser } from '@/lib/auth/auth';
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
    const { username } = await resolveUser(request);

    const evaluation = await prismaRaw.evaluation.findUnique({
      where: { id },
      include: {
        Skill: { select: { id: true, name: true, user: true } },
        Execution: { select: { id: true, taskId: true, query: true, model: true, framework: true, timestamp: true } },
        issues: {
          orderBy: [{ createdAt: 'asc' }],
        },
      },
    });

    if (!evaluation) {
      return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 });
    }

    if (evaluation.user && username && evaluation.user !== username) {
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

    let l2Scores: any = null;
    if (evaluation.l2ScoresJson) {
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
  } catch (e: any) {
    console.error('[Evaluation Detail] error:', e);
    return NextResponse.json({ error: e?.message || 'fetch failed' }, { status: 500 });
  }
}
