// 添加/编辑前后的连通性检测：
//  - mode=pull：主动探 endpoint 的 /metrics（可达 + 指标数 + model）。
//  - mode=push：查该源最近是否有新样本（push 模式下 poller 不再拉，新样本只能来自 collector 推送）。

import { NextResponse } from 'next/server';

import { probeEndpoint } from '@/lib/infra/registry';
import { lastPushAtMs } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

const FRESH_MS = 30_000; // 最近 30s 内有新样本 = collector 在推

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get('mode') === 'push' ? 'push' : 'pull';

  if (mode === 'pull') {
    const endpoint = searchParams.get('endpoint');
    if (!endpoint) return NextResponse.json({ error: 'Missing endpoint' }, { status: 400 });
    const probe = await probeEndpoint(endpoint, { timeoutMs: 6000 });
    return NextResponse.json({
      mode: 'pull',
      ok: probe.reachable,
      metricCount: probe.metricCount,
      model: probe.model,
      message: probe.reachable
        ? `可达，探测到 ${probe.metricCount} 个 vLLM 指标族（model=${probe.model ?? '未知'}）`
        : `不可达或非 vLLM 源${probe.error ? `：${probe.error}` : ''}`,
    });
  }

  // push：查该源最近一条「推送」样本（与是否已保存为 push 无关 → 支持"先配 collector、检测到再保存"）
  const sourceId = searchParams.get('sourceId');
  if (!sourceId) return NextResponse.json({ error: 'Missing sourceId' }, { status: 400 });
  const src = await prismaRaw.infraSource.findUnique({ where: { id: sourceId } });
  if (!src) return NextResponse.json({ mode: 'push', ok: false, message: '源不存在' }, { status: 404 });

  const lastMs = await lastPushAtMs(sourceId);
  if (lastMs == null) {
    return NextResponse.json({ mode: 'push', ok: false, message: '尚未收到任何推送。请在能访问该源的机器上按配置启动 collector。' });
  }
  const ago = Date.now() - lastMs;
  const ok = ago <= FRESH_MS;
  return NextResponse.json({
    mode: 'push',
    ok,
    lastPushMs: lastMs,
    agoMs: ago,
    message: ok
      ? `已收到 collector 推送（最近一条在 ${(ago / 1000).toFixed(0)}s 前）。`
      : `最近一条推送在 ${(ago / 1000).toFixed(0)}s 前（超 ${FRESH_MS / 1000}s）—— collector 可能已停。`,
  });
}
