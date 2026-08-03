// 接入源注册表 CRUD。endpoint 由 normalizeEndpoint 归一作主键（裸机源=scheme://host:port，
// 网关托管源保留实例路径）。authHeaders 含明文凭证 → GET 一律脱敏后返回。

import { NextResponse } from 'next/server';

import { redactSource, toAuthHeadersJson } from '@/lib/infra/auth-headers';
import { ensureSource } from '@/lib/infra/store';
import { metricsUrl, normalizeEndpoint } from '@/lib/ingest/vllm/scrape';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function GET() {
  const sources = await prismaRaw.infraSource.findMany({ orderBy: { createdAt: 'desc' } });
  // 绝不把 authHeaders 原样吐出去：这个接口没有任何鉴权，谁打开页面谁就能读。
  return NextResponse.json({ sources: sources.map(redactSource) });
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
      // 兜底必须从用户填的原始 URL 推，不能用归一后的 endpoint —— 后者已经把实例路径剥掉了，
      // 拼出来的 `${endpoint}/metrics` 对网关托管的源是个不存在的地址。
      scrapeUrl: body.scrapeUrl || metricsUrl(body.endpoint),
      kind: body.kind === 'push' ? 'push' : 'pull',
      model: body.model ?? null,
      hardwareName: body.hardwareName ?? null,
      memBandwidthGBs: body.memBandwidthGBs != null ? Number(body.memBandwidthGBs) : null,
      scrapeIntervalMs: body.scrapeIntervalMs != null ? Number(body.scrapeIntervalMs) : undefined,
      authHeaders: toAuthHeadersJson(body.authHeaders),
    });
    return NextResponse.json({ source: redactSource(src) });
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
    // undefined = 不改（前端不回填真值，所以「没动那个框」不能把已存的凭证抹掉）；
    // '' / null = 显式清除。
    const nextAuth = toAuthHeadersJson(body.authHeaders);
    if (nextAuth !== undefined) data.authHeaders = nextAuth;

    const source = await prismaRaw.infraSource.update({ where: { id: body.id }, data });
    return NextResponse.json({ source: redactSource(source) });
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
