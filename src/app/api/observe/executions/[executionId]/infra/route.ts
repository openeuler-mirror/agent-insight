// Session↔Infra 关联（会话级）：以整棵 trace 树（rootExecutionId）为单位，
// 枚举用到的每个 (endpoint, 模型) 组合 → 各出一张关联卡（窗口诊断 + 归因 INFRA/APP/INHERENT）。
// 人工覆盖：若该树存了 SessionInfraLink，则用人工集合替代自动按 endpoint 的推断。
//   GET  → 返回 cards[] + sessionWindow + manual 标记 + rootExecutionId
//   POST → body { links: [{sourceId, model}] } 覆盖式保存人工关联集合

import { NextResponse } from 'next/server';

import { classify, infraContextFor } from '@/lib/infra/correlate';
import { groupSessionInfraTargets, getSessionLinks, setSessionLinks } from '@/lib/infra/sessions';
import type { ExecRef, InfraTarget } from '@/lib/infra/sessions';
import { querySamples } from '@/lib/infra/store';
import { prismaRaw } from '@/lib/storage/prisma';
import type { HardwareProfile } from '@/lib/infra/types';

export const dynamic = 'force-dynamic';

interface TreeExec { endpoint: string | null; model: string | null; startMs: number; endMs: number; outTokens: number }

/** 解析整棵 trace 树：返回 rootId + 树内所有 execution 的 ref（含 token）。 */
async function loadTree(id: string): Promise<{ rootId: string; execs: TreeExec[] } | null> {
  const self = await prismaRaw.execution.findUnique({ where: { id }, select: { rootExecutionId: true } });
  if (!self) return null;
  const rootId = self.rootExecutionId || id;
  const rows = await prismaRaw.execution.findMany({
    where: { OR: [{ rootExecutionId: rootId }, { id: rootId }] },
    select: { endpoint: true, timestamp: true, latency: true, outputTokens: true, model: true },
  });
  const execs: TreeExec[] = rows.map((r) => {
    const endMs = r.timestamp.getTime();
    return { endpoint: r.endpoint ?? null, model: r.model ?? null, startMs: endMs - (r.latency ?? 0), endMs, outTokens: r.outputTokens ?? 0 };
  });
  return { rootId, execs };
}

/** 把一个 (endpoint, model, window) 目标做成关联卡（找源 → 窗口采样 → 诊断 → 归因）。 */
async function buildCard(target: InfraTarget, execs: TreeExec[]) {
  const source = await prismaRaw.infraSource.findUnique({ where: { endpoint: target.endpoint } });
  const base = { endpoint: target.endpoint, model: target.model, window: { startMs: target.startMs, endMs: target.endMs, latencyMs: target.endMs - target.startMs } };
  if (!source) {
    return { ...base, correlated: false, sourceId: null, reason: '该 endpoint 尚未注册为 infra 源', verdict: null, bottleneck: null, samples: 0, classification: null, findings: [] };
  }
  const samples = await querySamples(source.id, target.startMs - 2000, target.endMs + 2000, target.model ?? undefined);
  const hw: HardwareProfile | undefined = source.memBandwidthGBs != null
    ? { name: source.hardwareName ?? 'custom', memBandwidthGBs: source.memBandwidthGBs }
    : undefined;
  const ctx = infraContextFor({ startMs: target.startMs, endMs: target.endMs }, samples, hw);
  const outTokens = execs
    .filter((e) => e.endpoint === target.endpoint && (target.model == null || e.model === target.model))
    .reduce((a, e) => a + e.outTokens, 0);
  const cls = classify({ startMs: target.startMs, endMs: target.endMs, latencyMs: target.endMs - target.startMs, outTokens }, ctx);
  return {
    ...base,
    correlated: !!ctx,
    sourceId: source.id,
    reason: ctx ? undefined : '该时间窗内无 infra 采样',
    verdict: ctx?.diag.verdict ?? null,
    bottleneck: ctx?.diag.bottleneck ?? null,
    samples: ctx?.samples ?? 0,
    classification: cls,
    findings: ctx?.diag.findings ?? [],
  };
}

export async function GET(_req: Request, context: { params: Promise<{ executionId: string }> }) {
  const { executionId: id } = await context.params;
  const tree = await loadTree(id);
  if (!tree) return NextResponse.json({ error: 'execution not found' }, { status: 404 });

  const { rootId, execs } = tree;
  const withEndpoint = execs.filter((e) => e.endpoint);
  const sessionWindow = withEndpoint.length
    ? { startMs: Math.min(...withEndpoint.map((e) => e.startMs)), endMs: Math.max(...withEndpoint.map((e) => e.endMs)) }
    : null;
  // 人工关联的窗口：用整棵树所有 execution 的时间跨度（即便没采到 endpoint 也能手动指定源）
  const fullWindow = execs.length
    ? { startMs: Math.min(...execs.map((e) => e.startMs)), endMs: Math.max(...execs.map((e) => e.endMs)) }
    : null;

  // 人工覆盖优先：有则用人工集合（窗口取整段 session），否则按 (endpoint,model) 自动归并
  const manualLinks = await getSessionLinks(rootId);
  let targets: InfraTarget[];
  if (manualLinks.length > 0 && fullWindow) {
    const sources = await prismaRaw.infraSource.findMany({ where: { id: { in: manualLinks.map((l) => l.sourceId) } }, select: { id: true, endpoint: true } });
    const epById = new Map(sources.map((s) => [s.id, s.endpoint]));
    targets = manualLinks
      .map((l) => ({ endpoint: epById.get(l.sourceId), model: l.model, startMs: fullWindow.startMs, endMs: fullWindow.endMs }))
      .filter((t): t is InfraTarget => !!t.endpoint);
  } else {
    targets = groupSessionInfraTargets(execs as ExecRef[]);
  }

  const cards = await Promise.all(targets.map((t) => buildCard(t, execs)));

  return NextResponse.json({
    correlated: cards.some((c) => c.correlated),
    rootExecutionId: rootId,
    manual: manualLinks.length > 0,
    sessionWindow,
    reason: cards.length === 0 ? (sessionWindow ? '该 session 的推理源尚未注册为 infra 源' : 'session 无 endpoint（未采到真实推理源 URL）') : undefined,
    endpoint: withEndpoint[0]?.endpoint, // 兼容旧前端
    cards,
  });
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
