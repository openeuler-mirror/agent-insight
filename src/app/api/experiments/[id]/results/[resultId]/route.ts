// 人工修正得分：分层写入 humanScore/humanReason/humanBy/humanAt，机器分 score 原样保留。
// 聚合口径（src/lib/engine/experiment/detail-agg.ts）按 humanScore ?? score 取生效分，
// 所以改完这一行，综合均分/评估器分解/类目均分/单 case 得分全部自动跟随。
//
// humanScore 传 null = 撤销修正，回落机器分。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

/** 修正理由上限——够写清"为什么这个分不合理"，又不至于当评论用（评论走 comments 接口）。 */
const REASON_MAX = 1000;

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; resultId: string }> },
) {
  try {
    const { id, resultId } = await params;
    const body = await req.json().catch(() => ({}));
    const { username } = await resolveUser(req, body?.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    if (!('humanScore' in body)) {
      return NextResponse.json({ error: 'humanScore is required (null to clear)' }, { status: 400 });
    }
    const raw = body.humanScore;
    const clearing = raw === null;
    let humanScore: number | null = null;
    if (!clearing) {
      const n = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return NextResponse.json({ error: 'humanScore must be a number in [0,100], or null to clear' }, { status: 400 });
      }
      humanScore = Math.round(n * 10) / 10;
    }

    const reason = String(body?.humanReason ?? '').trim().slice(0, REASON_MAX);
    // 改分必须说明理由——没有理由的修正日后无法复盘，也没法用来校准评估器。
    if (!clearing && !reason) {
      return NextResponse.json({ error: 'humanReason is required when setting humanScore' }, { status: 400 });
    }

    // 权限 + 归属：结果行必须属于本人的这个实验
    const row = await prisma.experimentEvalResult.findFirst({
      where: { id: resultId, experimentId: id, case: { experiment: { user: username } } },
      select: { id: true, status: true, score: true },
    });
    if (!row) return NextResponse.json({ error: 'result not found' }, { status: 404 });

    // 只允许修正已完成的评估行。失败/待执行行没有可对照的机器判断，
    // 放开会让 failed 行凭人工分进了均分分母，口径变糊——先重评拿到结果再修正。
    if (row.status !== 'done') {
      return NextResponse.json(
        { error: '只能修正已完成的评估结果——失败或未执行的行请先重评' },
        { status: 409 },
      );
    }

    const updated = await prisma.experimentEvalResult.update({
      where: { id: resultId },
      data: clearing
        ? { humanScore: null, humanReason: null, humanBy: null, humanAt: null }
        : { humanScore, humanReason: reason, humanBy: username, humanAt: new Date() },
      select: { id: true, score: true, humanScore: true, humanReason: true, humanBy: true, humanAt: true },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error('[Experiment Result PATCH Error]', error);
    return NextResponse.json({ error: 'Failed to update evaluation score' }, { status: 500 });
  }
}
