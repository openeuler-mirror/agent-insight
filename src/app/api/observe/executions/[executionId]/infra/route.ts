// Session↔Infra 关联（会话级）：以整棵 trace 树（rootExecutionId）为单位，
// 枚举用到的每个 (endpoint, 模型) 组合 → 各出一张关联卡（窗口诊断 + 归因 INFRA/APP/INHERENT）。
// 人工覆盖：若该树存了 SessionInfraLink，则用人工集合替代自动按 endpoint 的推断。
//   GET  → 返回 cards[] + sessionWindow + manual 标记 + rootExecutionId
//   POST → body { links: [{sourceId, model}] } 覆盖式保存人工关联集合

import { NextResponse } from 'next/server';

import { buildExecutionInfraContext } from '@/lib/infra/execution-context';
import { setSessionLinks } from '@/lib/infra/sessions';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, context: { params: Promise<{ executionId: string }> }) {
  const { executionId: id } = await context.params;
  const contextValue = await buildExecutionInfraContext(id);
  if (!contextValue) return NextResponse.json({ error: 'execution not found' }, { status: 404 });
  return NextResponse.json(contextValue);
}

export async function POST(req: Request, context: { params: Promise<{ executionId: string }> }) {
  const { executionId: id } = await context.params;
  const self = await prismaRaw.execution.findUnique({ where: { id }, select: { rootExecutionId: true } });
  if (!self) return NextResponse.json({ error: 'execution not found' }, { status: 404 });
  const rootId = self.rootExecutionId || id;

  const body = await req.json().catch(() => null);
  const rawLinks = Array.isArray(body?.links) ? body.links : null;
  if (!rawLinks) return NextResponse.json({ error: 'body.links 必须是数组' }, { status: 400 });
  const links = rawLinks
    .filter((l: unknown): l is { sourceId: string; model?: string | null } => !!l && typeof (l as { sourceId?: unknown }).sourceId === 'string')
    .map((l: { sourceId: string; model?: string | null }) => ({ sourceId: l.sourceId, model: l.model ?? null }));

  await setSessionLinks(rootId, links);
  return NextResponse.json({ ok: true, rootExecutionId: rootId, count: links.length });
}
