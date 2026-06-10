/**
 * PATCH /api/skill-opt/plan/items/[id]
 *   body: { user, route?, status?, conflictResolution? }
 *
 * 用户仲裁/调整单条 plan item：
 *   - 改 route（core ↔ reference ↔ backlog）
 *   - 改 status：conflict → pending（仲裁通过，conflictResolution 追加进 rationale）
 *                pending/conflict → dismissed（弃用；源 issues 留在台账下轮再归并）
 *
 * 不允许把 status 改成 applied——那由 iteration 落库时统一回写（见 iterations 路由）。
 */

import { NextRequest, NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

const VALID_ROUTES = new Set(['core', 'reference', 'backlog']);
const VALID_STATUS_TARGETS = new Set(['pending', 'dismissed', 'deferred']);

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }
  const { username: user } = await resolveUser(req, typeof body?.user === 'string' ? body.user : null);
  if (!user) return NextResponse.json({ error: 'user required' }, { status: 400 });

  const item = await (prismaRaw as any).skillOptPlanItem.findUnique({
    where: { id },
    include: { plan: { select: { status: true } } },
  });
  if (!item) return NextResponse.json({ error: 'item not found' }, { status: 404 });
  if (item.status === 'applied' || item.plan?.status === 'applied') {
    return NextResponse.json({ error: 'plan already applied, item immutable' }, { status: 409 });
  }

  const data: any = {};
  if (body.route !== undefined) {
    if (!VALID_ROUTES.has(body.route)) return NextResponse.json({ error: 'invalid route' }, { status: 400 });
    data.route = body.route;
  }
  if (body.status !== undefined) {
    if (!VALID_STATUS_TARGETS.has(body.status)) {
      return NextResponse.json({ error: 'invalid status target' }, { status: 400 });
    }
    data.status = body.status;
    // conflict → pending 仲裁：把用户的取舍说明沉进 rationale，保住审计链
    if (item.status === 'conflict' && body.status === 'pending') {
      const note = typeof body.conflictResolution === 'string' ? body.conflictResolution.trim() : '';
      data.rationale = note
        ? `${item.rationale}\n\n【用户仲裁】${note}`
        : item.rationale;
      data.conflictNote = null;
    }
  }
  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'nothing to update' }, { status: 400 });
  }

  const updated = await (prismaRaw as any).skillOptPlanItem.update({ where: { id }, data });
  return NextResponse.json({
    item: {
      id: updated.id,
      rank: updated.rank,
      route: updated.route,
      status: updated.status,
      title: updated.title,
      rationale: updated.rationale,
      conflictNote: updated.conflictNote,
    },
  });
}
