// 某个 infra 源在指定时间窗内「有哪些 session 在干活」。
// 解析 source.endpoint 后查命中该 endpoint 的 execution，与详情页的 infra 曲线共用同一时间轴。

import { NextResponse } from 'next/server';

import { countSessionsForEndpoint, listSessionsForEndpoint } from '@/lib/infra/sessions';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sourceId = searchParams.get('sourceId');
  if (!sourceId) return NextResponse.json({ error: 'Missing sourceId' }, { status: 400 });

  const src = await prismaRaw.infraSource.findUnique({ where: { id: sourceId }, select: { endpoint: true } });
  if (!src) return NextResponse.json({ error: 'source not found' }, { status: 404 });

  const toRaw = searchParams.get('to');
  const fromRaw = searchParams.get('from');
  const to = toRaw ? Number(toRaw) : Date.now();
  const from = fromRaw ? Number(fromRaw) : to - 15 * 60_000; // 缺省最近 15 分钟
  const pageSize = Math.min(100, Math.max(1, Number(searchParams.get('pageSize') || 10)));
  const page = Math.max(1, Number(searchParams.get('page') || 1));

  const total = await countSessionsForEndpoint(src.endpoint, from, to);
  const sessions = await listSessionsForEndpoint(src.endpoint, from, to, { limit: pageSize, offset: (page - 1) * pageSize });

  return NextResponse.json({ endpoint: src.endpoint, from, to, total, page, pageSize, count: sessions.length, sessions });
}
