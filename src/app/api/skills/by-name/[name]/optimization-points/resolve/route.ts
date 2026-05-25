/**
 * PATCH /api/skills/by-name/[name]/optimization-points/resolve
 * body: { user, ids: string[], threadId?: string }
 *
 * 把指定 SkillIssue.id 列表的 resolvedAt 置为当前时间 + 标记 resolvedRunId=threadId。
 * skill-opt 完成一轮优化后回调，避免下次列表里再出现同一 issue。
 *
 * 写在 SkillIssue（不是已废弃的 SkillOptimizationPoint）。双保险：
 *   - user 必须匹配
 *   - path 上的 skillName 必须等于 SkillIssue 关联 Skill 的 name
 */

import { NextRequest, NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const { name } = await ctx.params;
  const skillName = decodeURIComponent(String(name || '').trim());
  if (!skillName) return NextResponse.json({ error: 'skill name required' }, { status: 400 });

  let body: { user?: string; ids?: string[]; threadId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const user = String(body.user || '').trim();
  const ids = Array.isArray(body.ids) ? body.ids.filter(x => typeof x === 'string' && x.length > 0) : [];
  if (!user) return NextResponse.json({ error: 'user required' }, { status: 400 });
  if (ids.length === 0) return NextResponse.json({ error: 'ids required' }, { status: 400 });

  // 取这些 SkillIssue 关联的 Skill.name 做一致性校验——防止跨 skill 误改
  const candidates = await prismaRaw.skillIssue.findMany({
    where: { id: { in: ids }, user, resolvedAt: null },
    select: { id: true, Skill: { select: { name: true } } },
  });

  const validIds = candidates
    .filter(c => c.Skill?.name === skillName)
    .map(c => c.id);

  if (validIds.length === 0) {
    return NextResponse.json({ resolvedCount: 0 });
  }

  const result = await prismaRaw.skillIssue.updateMany({
    where: { id: { in: validIds }, user, resolvedAt: null },
    data: {
      resolvedAt: new Date(),
      resolvedRunId: body.threadId || null,
    },
  });

  return NextResponse.json({ resolvedCount: result.count });
}
