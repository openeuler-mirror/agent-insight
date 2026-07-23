// 实验详情：实验 + cases + results（执行引擎写入的每行 status/score/points/evidence）
// 与进度统计 progress = {total, done, failed, pending}（running 计入 pending 口径）。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));

    const experiment = await prisma.experiment.findFirst({
      where: { id, ...(username ? { user: username } : {}) },
      include: {
        cases: {
          orderBy: { createdAt: 'asc' },
          include: { results: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    if (!experiment) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }

    let evaluatorIds: string[] = [];
    try {
      const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
      if (Array.isArray(parsed)) evaluatorIds = parsed.map(String);
    } catch { /* 忽略脏数据 */ }

    const parseJson = (s: string | null): unknown => {
      if (!s) return null;
      try { return JSON.parse(s); } catch { return null; }
    };
    const results = experiment.cases.flatMap((c: any) =>
      c.results.map((r: any) => ({
        id: r.id,
        caseId: r.caseId,
        evaluatorId: r.evaluatorId,
        status: r.status,
        score: r.score,
        points: parseJson(r.pointsJson),
        evidence: parseJson(r.evidenceJson),
        errorMessage: r.errorMessage,
        attempts: r.attempts,
        durationMs: r.durationMs,
      })),
    );
    const progress = {
      total: results.length,
      done: results.filter((r: any) => r.status === 'done').length,
      failed: results.filter((r: any) => r.status === 'failed').length,
      pending: results.filter((r: any) => r.status === 'pending' || r.status === 'running').length,
    };

    return NextResponse.json({
      id: experiment.id,
      name: experiment.name,
      type: experiment.type,
      agentName: experiment.agentName,
      status: experiment.status,
      watchMode: experiment.watchMode,
      watchEnabledAt: experiment.watchEnabledAt,
      evaluatorIds,
      createdAt: experiment.createdAt,
      cases: experiment.cases.map((c: any) => ({
        id: c.id,
        executionId: c.executionId,
        taskId: c.taskId,
        input: c.input,
        actualOutput: c.actualOutput,
        referenceOutput: c.referenceOutput,
      })),
      results,
      progress,
    });
  } catch (error) {
    console.error('[Experiment Detail Error]', error);
    return NextResponse.json({ error: 'Failed to load experiment' }, { status: 500 });
  }
}

// 停止监听：把监听实验的 watchMode 置回 false（触发查询 where watchMode=true 即不再命中，
// 该 Agent 后续新 trace 不再自动进来评；已评结果全部保留）。目前仅支持关闭。
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { username } = await resolveUser(req, body?.user);
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

    if (body?.watchMode !== false) {
      return NextResponse.json({ error: 'only supports watchMode:false (stop watching)' }, { status: 400 });
    }

    const exp = await prisma.experiment.findFirst({
      where: { id, user: username },
      select: { id: true },
    });
    if (!exp) return NextResponse.json({ error: 'experiment not found' }, { status: 404 });

    await prisma.experiment.update({
      where: { id },
      data: { watchMode: false, watchEnabledAt: null },
    });
    return NextResponse.json({ success: true, watchMode: false });
  } catch (error) {
    console.error('[Experiment PATCH Error]', error);
    return NextResponse.json({ error: 'Failed to update experiment' }, { status: 500 });
  }
}
