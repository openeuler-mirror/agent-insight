import { resolveUser } from '@/lib/auth/auth';
import { prismaRaw } from '@/lib/storage/prisma';
import { NextRequest, NextResponse } from 'next/server';

/**
 * 取当前 SkillVersion 的最近一次静态评估概述（用于 SkillVersionDetailModal 顶部展示）。
 *
 * 输出：
 *   - latest: 最近 ranAt 的 Evaluation + 聚合 issue 统计；不存在则 null
 *   - history: 最近 5 条 evaluation 的 id/ranAt/status/issuesCount，便于跳详情页
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version: string }> },
) {
  try {
    const { id, version: versionStr } = await params;
    const version = parseInt(versionStr, 10);
    if (isNaN(version)) {
      return NextResponse.json({ error: 'Invalid version number' }, { status: 400 });
    }

    const url = new URL(request.url);
    const explicitUser = url.searchParams.get('user') || undefined;
    const { username } = await resolveUser(request, explicitUser);

    const userFilter = username
      ? { OR: [{ user: username }, { user: null }] }
      : {};

    const evaluations = await prismaRaw.evaluation.findMany({
      where: {
        skillId: id,
        version,
        type: 'static',
        ...userFilter,
      },
      orderBy: { ranAt: 'desc' },
      take: 5,
      include: {
        issues: { select: { severity: true } },
      },
    });

    if (evaluations.length === 0) {
      return NextResponse.json({ latest: null, history: [] });
    }

    const histogramFor = (issues: { severity: string }[]) => {
      const h = { high: 0, medium: 0, low: 0 };
      for (const i of issues) {
        if (i.severity === 'high') h.high++;
        else if (i.severity === 'medium') h.medium++;
        else if (i.severity === 'low') h.low++;
      }
      return h;
    };

    const top = evaluations[0];
    const latest = {
      evaluationId: top.id,
      ranAt: top.ranAt,
      status: top.status,
      generator: top.generator,
      durationMs: top.durationMs,
      errorMessage: top.errorMessage,
      contentHash: top.contentHash,
      issuesCount: top.issues.length,
      severityHistogram: histogramFor(top.issues),
      l2Scores: top.l2ScoresJson ? safeParse(top.l2ScoresJson) : null,
    };

    const history = evaluations.map(e => ({
      evaluationId: e.id,
      ranAt: e.ranAt,
      status: e.status,
      generator: e.generator,
      issuesCount: e.issues.length,
      severityHistogram: histogramFor(e.issues),
    }));

    return NextResponse.json({ latest, history });
  } catch (e: any) {
    console.error('[Static Eval] Summary fetch error:', e);
    return NextResponse.json({ error: e?.message || 'fetch failed' }, { status: 500 });
  }
}

function safeParse(json: string): any {
  try { return JSON.parse(json); } catch { return null; }
}
