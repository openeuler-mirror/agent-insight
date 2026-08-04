// 评测评论：对一次评测结果留意见/建议。三粒度共用一张表，用查询参数圈定范围——
//   无 caseId/resultId → 实验级；?caseId=… → 该 case 级；?resultId=… → 该评估器结果行级。
//
// 与 ExperimentEvalResult.humanReason 的分工：那个是"改分必填的结构化理由"（一条、
// 跟着分走），这里是自由的多条讨论（可追加、可删除、不影响任何统计口径）。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

const BODY_MAX = 2000;

/** 按查询/请求参数圈定评论范围。resultId 比 caseId 更具体，同时给以 resultId 为准。 */
function scopeWhere(experimentId: string, caseId: string, resultId: string): Record<string, unknown> {
  if (resultId) return { experimentId, resultId };
  if (caseId) return { experimentId, caseId, resultId: null };
  return { experimentId, caseId: null, resultId: null };
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const q = url.searchParams;
    const { username } = await resolveUser(req, q.get('user'));
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

    const experiment = await prisma.experiment.findFirst({
      where: { id, user: username },
      select: { id: true },
    });
    if (!experiment) return NextResponse.json({ error: 'experiment not found' }, { status: 404 });

    // scope=all：一次取回本实验下全部评论，前端按 caseId/resultId 自行分组
    // （详情页要同时渲染实验级 + 每个结果行的评论，避免 N+1 次请求）。
    const all = q.get('scope') === 'all';
    const rows = await prisma.experimentEvalComment.findMany({
      where: all ? { experimentId: id } : scopeWhere(id, q.get('caseId') || '', q.get('resultId') || ''),
      orderBy: { createdAt: 'asc' },
      take: 500,
    });

    return NextResponse.json({ items: rows });
  } catch (error) {
    console.error('[Experiment Comments GET Error]', error);
    return NextResponse.json({ error: 'Failed to load comments' }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { username } = await resolveUser(req, body?.user);
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

    const text = String(body?.body ?? '').trim().slice(0, BODY_MAX);
    if (!text) return NextResponse.json({ error: 'body is required' }, { status: 400 });

    const experiment = await prisma.experiment.findFirst({
      where: { id, user: username },
      select: { id: true },
    });
    if (!experiment) return NextResponse.json({ error: 'experiment not found' }, { status: 404 });

    const caseId = String(body?.caseId ?? '').trim() || null;
    const resultId = String(body?.resultId ?? '').trim() || null;
    // 归属校验：不允许把评论挂到别的实验的 case/结果行上
    if (resultId) {
      const row = await prisma.experimentEvalResult.findFirst({
        where: { id: resultId, experimentId: id },
        select: { id: true },
      });
      if (!row) return NextResponse.json({ error: 'result not found in this experiment' }, { status: 404 });
    } else if (caseId) {
      const row = await prisma.experimentCase.findFirst({
        where: { id: caseId, experimentId: id },
        select: { id: true },
      });
      if (!row) return NextResponse.json({ error: 'case not found in this experiment' }, { status: 404 });
    }

    const created = await prisma.experimentEvalComment.create({
      data: { experimentId: id, caseId, resultId, user: username, body: text },
    });
    return NextResponse.json(created);
  } catch (error) {
    console.error('[Experiment Comments POST Error]', error);
    return NextResponse.json({ error: 'Failed to add comment' }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

    const commentId = String(url.searchParams.get('commentId') || '').trim();
    if (!commentId) return NextResponse.json({ error: 'commentId is required' }, { status: 400 });

    // 只能删自己在自己实验里留的评论
    const row = await prisma.experimentEvalComment.findFirst({
      where: { id: commentId, experimentId: id, user: username, experiment: { user: username } },
      select: { id: true },
    });
    if (!row) return NextResponse.json({ error: 'comment not found' }, { status: 404 });

    await prisma.experimentEvalComment.delete({ where: { id: commentId } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('[Experiment Comments DELETE Error]', error);
    return NextResponse.json({ error: 'Failed to delete comment' }, { status: 500 });
  }
}
