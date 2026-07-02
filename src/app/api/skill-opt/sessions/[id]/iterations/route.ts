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
 *     resolvedIssueIds?: string[],    // 这次处理的 issue id 数组（平铺 issues 模式）
 *     appliedPlanItemIds?: string[]   // plan 模式：本次落实的 plan item id 数组；
 *                                     // 后端展开为源 SkillIssue id 并入 resolvedIssueIds，
 *                                     // 同时把对应 item 置 applied（plan 全部 core/reference
 *                                     // 条目终态后 plan 置 applied）
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
    const { summary, files, resolvedIssueIds, appliedPlanItemIds } = body;

    if (typeof summary !== 'string') {
      return NextResponse.json({ error: 'summary must be a string' }, { status: 400 });
    }
    if (!files || typeof files !== 'object') {
      return NextResponse.json({ error: 'files must be an object' }, { status: 400 });
    }

    // ── plan 模式：appliedPlanItemIds → 展开源 SkillIssue id 并入 resolvedIssueIds，
    // 同时把 item 置 applied。SkillIssue 台账的 resolvedAt 回标仍由前端走既有
    // PATCH /optimization-points/resolve（输入就是这里展开后的 resolvedIssueIds）。
    let effectiveResolvedIds: string[] = Array.isArray(resolvedIssueIds) ? resolvedIssueIds : [];
    const planItemIds: string[] = Array.isArray(appliedPlanItemIds)
      ? appliedPlanItemIds.filter((x: unknown) => typeof x === 'string' && x.length > 0)
      : [];
    if (planItemIds.length > 0) {
      const items = await (prismaRaw as any).skillOptPlanItem.findMany({
        where: { id: { in: planItemIds }, plan: { sessionId: id } },  // 只认本会话 plan 的 item
        select: { id: true, planId: true, sourceIssueIds: true },
      });
      const expanded = new Set<string>(effectiveResolvedIds);
      for (const it of items) {
        try {
          for (const sid of JSON.parse(it.sourceIssueIds || '[]')) {
            if (typeof sid === 'string') expanded.add(sid);
          }
        } catch { /* 坏 JSON 跳过该 item 的展开 */ }
      }
      effectiveResolvedIds = Array.from(expanded);

      if (items.length > 0) {
        await (prismaRaw as any).skillOptPlanItem.updateMany({
          where: { id: { in: items.map((it: any) => it.id) } },
          data: { status: 'applied' },
        });
        // core/reference 条目全部到达终态（applied/dismissed）→ plan 置 applied
        const planId = items[0].planId;
        const openCount = await (prismaRaw as any).skillOptPlanItem.count({
          where: { planId, route: { in: ['core', 'reference'] }, status: { in: ['pending', 'conflict'] } },
        });
        if (openCount === 0) {
          await (prismaRaw as any).skillOptPlan.update({ where: { id: planId }, data: { status: 'applied' } });
        }
      }
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
        resolvedIssueIds: JSON.stringify(effectiveResolvedIds),
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
