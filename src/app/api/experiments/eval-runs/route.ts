// 实验版「评测任务(批次)列表」读接口——对齐旧 /api/eval/trajectory/runs 的消费形状，
// 供 skill 概览页 caseEvalTasks / _batch evalTasks「选历史评测任务」显示读取。
// 一个作评测后端的 Experiment = 一条 run（runId = experimentId）。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

/** 单个 case 的综合分（0-1）：其已完成评估器分数(0-100)均值 ÷ 100；无 done → null。 */
function caseScore01(results: { status: string; score: number | null }[]): number | null {
  const done = results.filter((r) => r.status === 'done' && typeof r.score === 'number');
  if (!done.length) return null;
  const avg = done.reduce((s, r) => s + (r.score as number), 0) / done.length;
  return Math.round((avg / 100) * 1000) / 1000;
}

function caseStatus(results: { status: string }[]): 'done' | 'running' | 'failed' | 'pending' {
  if (!results.length) return 'pending';
  if (results.some((r) => r.status === 'pending' || r.status === 'running')) return 'running';
  if (results.every((r) => r.status === 'done')) return 'done';
  if (results.some((r) => r.status === 'failed')) return 'failed';
  return 'pending';
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const q = url.searchParams;
    const { username } = await resolveUser(req, q.get('user'));
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

    const scope = q.get('scope') || '';
    const skillName = q.get('skillName') || '';
    const skillVersionRaw = q.get('skillVersion');
    const excludeGrayscale = q.get('excludeGrayscale') === '1' || q.get('excludeGrayscale') === 'true';
    const includeRunId = q.get('includeRunId') || '';
    const limit = Math.min(Number(q.get('limit')) || 50, 50);
    const offset = Math.max(Number(q.get('offset')) || 0, 0);

    const where: Record<string, unknown> = { user: username };
    // 只列作评测后端的实验（scope 非空）；用户手建的单组实验(scope='')不进评测任务列表
    if (scope) where.scope = scope;
    else where.scope = excludeGrayscale ? { notIn: ['', 'grayscale-ab'] } : { not: '' };
    if (skillName) where.skillName = skillName;
    if (skillVersionRaw != null && skillVersionRaw !== '' && !Number.isNaN(Number(skillVersionRaw))) {
      where.skillVersion = Number(skillVersionRaw);
    }

    const rows = await prisma.experiment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      skip: offset,
      select: {
        id: true, name: true, scope: true, skillName: true, skillVersion: true,
        agentName: true, evaluatorIdsJson: true, createdAt: true,
        cases: { select: { results: { select: { status: true, score: true } } } },
      },
    });

    // includeRunId：确保指定实验也在列表里（不在分页窗口时补拉一条）
    let extra: typeof rows = [];
    if (includeRunId && !rows.some((r: { id: string }) => r.id === includeRunId)) {
      extra = await prisma.experiment.findMany({
        where: { id: includeRunId, user: username },
        select: {
          id: true, name: true, scope: true, skillName: true, skillVersion: true,
          agentName: true, evaluatorIdsJson: true, createdAt: true,
          cases: { select: { results: { select: { status: true, score: true } } } },
        },
      });
    }

    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    type ExpCase = { results: { status: string; score: number | null }[] };
    const runs = [...extra, ...page].map((exp) => {
      let evaluatorIds: string[] = [];
      try { const p = JSON.parse(exp.evaluatorIdsJson || '[]'); if (Array.isArray(p)) evaluatorIds = p.map(String); } catch { /* 忽略 */ }
      const caseStates = exp.cases.map((c: ExpCase) => ({ score: caseScore01(c.results), status: caseStatus(c.results) }));
      const doneScores = caseStates.map((c: { score: number | null }) => c.score).filter((s: number | null): s is number => typeof s === 'number');
      const avgScore = doneScores.length ? Math.round((doneScores.reduce((s: number, v: number) => s + v, 0) / doneScores.length) * 1000) / 1000 : null;
      return {
        runId: exp.id,
        taskTitle: exp.name,
        taskScope: exp.scope,
        skillName: exp.skillName || undefined,
        skillVersion: typeof exp.skillVersion === 'number' ? exp.skillVersion : null,
        executionAgent: exp.agentName || undefined,
        evaluatorIds,
        traceCount: exp.cases.length,
        doneCount: caseStates.filter((c: { status: string }) => c.status === 'done').length,
        runningCount: caseStates.filter((c: { status: string }) => c.status === 'running').length,
        failedCount: caseStates.filter((c: { status: string }) => c.status === 'failed').length,
        avgScore,
        createdAt: exp.createdAt,
        source: exp.scope === 'grayscale-ab' ? 'grayscale-ab' : 'standalone',
      };
    });

    return NextResponse.json({ runs, nextOffset: offset + page.length, hasMore });
  } catch (error) {
    console.error('[experiments/eval-runs GET Error]', error);
    return NextResponse.json({ error: 'Failed to load eval runs' }, { status: 500 });
  }
}
