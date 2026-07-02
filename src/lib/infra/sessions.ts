// Infra↔Session 反向关联：给定一个推理源 endpoint 和时间窗，列出该窗口内命中它的 execution（会话）。
// 与 correlate.ts（单条 execution → infra）方向相反：这里是「某段时间这个源上有哪些 session 在干活」。

import { prismaRaw } from '@/lib/storage/prisma';

export interface SessionForEndpoint {
  id: string;
  taskId: string | null;
  tsMs: number;
  latencyMs: number | null;
  model: string | null;
  outputTokens: number | null;
  agentName: string | null;
}

/** 该 endpoint 在 [fromMs, toMs] 内命中的 execution 总数（分页用）。 */
export async function countSessionsForEndpoint(endpoint: string, fromMs: number, toMs: number): Promise<number> {
  if (!endpoint) return 0;
  return prismaRaw.execution.count({ where: { endpoint, timestamp: { gte: new Date(fromMs), lte: new Date(toMs) } } });
}

/** 列出 [fromMs, toMs] 内、endpoint 命中该源的 execution（按时间降序=最近优先，支持 offset/limit 分页）。 */
export async function listSessionsForEndpoint(endpoint: string, fromMs: number, toMs: number, opts: { limit?: number; offset?: number } = {}): Promise<SessionForEndpoint[]> {
  if (!endpoint) return [];
  const rows = await prismaRaw.execution.findMany({
    where: { endpoint, timestamp: { gte: new Date(fromMs), lte: new Date(toMs) } },
    orderBy: { timestamp: 'desc' },
    skip: Math.max(0, opts.offset ?? 0),
    take: Math.min(200, Math.max(1, opts.limit ?? 20)),
    select: { id: true, taskId: true, timestamp: true, latency: true, model: true, outputTokens: true, agentName: true },
  });
  return rows.map((r) => ({
    id: r.id,
    taskId: r.taskId ?? null,
    tsMs: r.timestamp.getTime(),
    latencyMs: r.latency ?? null,
    model: r.model ?? null,
    outputTokens: r.outputTokens ?? null,
    agentName: r.agentName ?? null,
  }));
}

// ---- 会话级（整棵 trace 树）→ 多个 (endpoint, 模型) 关联目标 ----

export interface ExecRef { endpoint: string | null; model: string | null; startMs: number; endMs: number }
export interface InfraTarget { endpoint: string; model: string | null; startMs: number; endMs: number }

/**
 * 把整棵 trace 树的 execution 按 (endpoint, model) 归并成关联目标：
 * 同 (endpoint, model) 合并成一组，窗口取组内 [min start, max end]；无 endpoint 的丢弃。
 * 一个 session 用了多个模型 → 返回多个目标（每个一张关联卡）。
 */
export function groupSessionInfraTargets(execs: ExecRef[]): InfraTarget[] {
  const byKey = new Map<string, InfraTarget>();
  for (const e of execs) {
    if (!e.endpoint) continue;
    const key = `${e.endpoint}\u0000${e.model ?? ''}`;
    const cur = byKey.get(key);
    if (cur) {
      cur.startMs = Math.min(cur.startMs, e.startMs);
      cur.endMs = Math.max(cur.endMs, e.endMs);
    } else {
      byKey.set(key, { endpoint: e.endpoint, model: e.model ?? null, startMs: e.startMs, endMs: e.endMs });
    }
  }
  // 确定性排序：endpoint 优先，再 model
  return [...byKey.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint) || String(a.model).localeCompare(String(b.model)));
}

export interface SessionLink { sourceId: string; model: string | null }

/** 读某棵树的人工覆盖关联集合（无 = 空数组 = 走自动推断）。 */
export async function getSessionLinks(rootExecutionId: string): Promise<SessionLink[]> {
  const rows = await prismaRaw.sessionInfraLink.findMany({
    where: { rootExecutionId },
    select: { sourceId: true, model: true },
    orderBy: { createdAt: 'asc' },
  });
  return rows.map((r) => ({ sourceId: r.sourceId, model: r.model ?? null }));
}

/** 覆盖式保存某棵树的人工关联集合（整体替换；空数组 = 清空，回落到自动推断）。 */
export async function setSessionLinks(rootExecutionId: string, links: SessionLink[]): Promise<void> {
  // 去重（含 model=null）
  const seen = new Set<string>();
  const uniq = links.filter((l) => {
    const k = `${l.sourceId}\u0000${l.model ?? ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await prismaRaw.$transaction([
    prismaRaw.sessionInfraLink.deleteMany({ where: { rootExecutionId } }),
    ...uniq.map((l) => prismaRaw.sessionInfraLink.create({ data: { rootExecutionId, sourceId: l.sourceId, model: l.model } })),
  ]);
}
