import { NextRequest, NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

/**
 * POST /api/skill-opt/sessions/[id]/iterations
 *
 * 持久化一个草稿快照。前端在每次 agent turn 跑完时调一次，body 形态：
 *   {
 *     summary: string,            // agent 输出的"## 修改总结" markdown
 *     files: Record<string, string>,  // 全量快照（key 是相对路径，无 /workspace/ 前缀）
 *     resolvedIssueIds?: string[]     // 这次处理的 issue id 数组
 *   }
 *
 * draftNumber 由后端在 session 内单调递增分配，前端不传——避免并发请求同时点"开始优化"
 * 时取到相同编号导致 unique 冲突。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { summary, files, resolvedIssueIds } = body;

    if (typeof summary !== 'string') {
      return NextResponse.json({ error: 'summary must be a string' }, { status: 400 });
    }
    if (!files || typeof files !== 'object') {
      return NextResponse.json({ error: 'files must be an object' }, { status: 400 });
    }

    // 验证 session 存在 + 拿当前最大 draftNumber
    const last = await (prismaRaw as any).skillOptIteration.findFirst({
      where: { sessionId: id },
      orderBy: { draftNumber: 'desc' },
      select: { draftNumber: true },
    });
    const nextDraftNumber = (last?.draftNumber ?? 0) + 1;

    const iteration = await (prismaRaw as any).skillOptIteration.create({
      data: {
        sessionId: id,
        draftNumber: nextDraftNumber,
        summary,
        files: JSON.stringify(files),
        resolvedIssueIds: JSON.stringify(Array.isArray(resolvedIssueIds) ? resolvedIssueIds : []),
      },
    });

    // 顺手把 session.updatedAt 推一下，列表排序能感知最新活动
    await (prismaRaw as any).skillOptSession.update({
      where: { id },
      data: { updatedAt: new Date() },
    });

    return NextResponse.json({ iteration });
  } catch (error: any) {
    console.error('[skill-opt iterations POST] failed:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
