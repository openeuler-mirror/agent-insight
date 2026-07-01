// 接入源注册表 CRUD。endpoint 归一为 scheme://host:port 作主键。

import { NextResponse } from 'next/server';

import { ensureSource } from '@/lib/infra/store';
import { normalizeEndpoint } from '@/lib/ingest/vllm/scrape';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sources = await prismaRaw.infraSource.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ sources });
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    if (!body?.endpoint) {
      return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    }
    const endpoint = normalizeEndpoint(body.endpoint);
    const src = await ensureSource({
      endpoint,
      scrapeUrl: body.scrapeUrl || `${endpoint}/metrics`,
      kind: body.kind === 'push' ? 'push' : 'pull',
      model: body.model ?? null,
      hardwareName: body.hardwareName ?? null,
      memBandwidthGBs: body.memBandwidthGBs != null ? Number(body.memBandwidthGBs) : null,
      scrapeIntervalMs: body.scrapeIntervalMs != null ? Number(body.scrapeIntervalMs) : undefined,
    });
    return NextResponse.json({ source: src });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: 'error', message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const body = await req.json();
    if (!body?.id) {
      return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }
    const data: Record<string, unknown> = {};
    if (body.kind === 'pull' || body.kind === 'push') data.kind = body.kind;
    if (body.scrapeIntervalMs != null) {
      const ms = Number(body.scrapeIntervalMs);
      if (!Number.isFinite(ms) || ms < 1000) {
        return NextResponse.json({ error: 'scrapeIntervalMs 需 >= 1000' }, { status: 400 });
      }
      data.scrapeIntervalMs = ms;
    }
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (body.scrapeUrl != null) data.scrapeUrl = String(body.scrapeUrl);
    if (body.hardwareName !== undefined) data.hardwareName = body.hardwareName || null;
    if (body.memBandwidthGBs !== undefined) {
      data.memBandwidthGBs = body.memBandwidthGBs != null ? Number(body.memBandwidthGBs) : null;
    }
    if (body.model !== undefined) data.model = body.model || null;

    const source = await prismaRaw.infraSource.update({ where: { id: body.id }, data });
    return NextResponse.json({ source });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ status: 'error', message }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  const endpoint = searchParams.get('endpoint');
  if (!id && !endpoint) {
    return NextResponse.json({ error: 'Provide id or endpoint' }, { status: 400 });
  }
  const { count } = await prismaRaw.infraSource.deleteMany({
    where: id ? { id } : { endpoint: endpoint as string },
  });
  return NextResponse.json({ deleted: count });
}
