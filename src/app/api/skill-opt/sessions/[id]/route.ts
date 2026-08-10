import { NextRequest, NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { isUsageEnabled } from '@/lib/usage-analytics/config';

export const dynamic = 'force-dynamic';

/**
 * GET /api/skill-opt/sessions/[id]
 * 单会话详情：含全部 messages（按 createdAt 升序）和 iterations（按 draftNumber 升序）。
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const session = await (prismaRaw as any).skillOptSession.findUnique({
      where: { id },
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        iterations: { orderBy: { draftNumber: 'asc' } },
      },
    });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }
    return NextResponse.json({ session });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * PATCH /api/skill-opt/sessions/[id]
 * 改 title / files。messages / iterations 不在这里改（chat 路由 + iterations 路由各自负责）。
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();
    const { title, files } = body;

    const data: any = {};
    if (title !== undefined) data.title = title;
    if (files !== undefined) data.files = typeof files === 'string' ? files : JSON.stringify(files);

    const session = await (prismaRaw as any).skillOptSession.update({
      where: { id },
      data,
      include: {
        messages: { orderBy: { createdAt: 'asc' } },
        iterations: { orderBy: { draftNumber: 'asc' } },
      },
    });
    return NextResponse.json({ session });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

/**
 * DELETE /api/skill-opt/sessions/[id]
 * 级联删除（schema onDelete: Cascade 同步带走 messages + iterations）。
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;

    // 删除后拿不到归属人，先读一次；只在统计开启时才多这一次查询。
    const owner = isUsageEnabled()
      ? (await (prismaRaw as any).skillOptSession.findUnique({ where: { id }, select: { user: true } }))?.user
      : null;

    await (prismaRaw as any).skillOptSession.delete({ where: { id } });

    recordUsageEvent({ user: owner, featureKey: 'skill-opt', eventKey: 'skill.optimize.session.delete' });

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
