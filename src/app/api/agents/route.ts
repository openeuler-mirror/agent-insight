import { NextResponse } from 'next/server';
import { prismaRaw } from '@/lib/storage/prisma';
import { ensureAllSystemAgents } from '@/lib/system-agents';
import { extractObservedAgentRegistrations } from '@/lib/engine/observability/agent-registration';

export const dynamic = 'force-dynamic';

async function backfillObservedAgentsFromSessions(user?: string) {
  const executions = await (prismaRaw as any).execution.findMany({
    where: {
      taskId: { not: null },
      framework: { not: null },
      ...(user ? { user } : {}),
    },
    select: {
      taskId: true,
      framework: true,
      agentName: true,
      user: true,
      timestamp: true,
    },
    orderBy: { timestamp: 'desc' },
    take: 300,
  });

  const taskIds = Array.from(new Set(
    executions.map((e: any) => String(e.taskId || '').trim()).filter(Boolean),
  ));
  if (taskIds.length === 0) return;

  const sessions = await (prismaRaw as any).session.findMany({
    where: { taskId: { in: taskIds } },
    select: { taskId: true, interactions: true },
  });
  const sessionByTaskId = new Map<string, { taskId: string; interactions?: string | null }>(
    sessions.map((s: any) => [s.taskId, s]),
  );

  const seen = new Set<string>();
  for (const execution of executions) {
    const platform = String(execution.framework || '').trim();
    if (!platform) continue;

    const session = sessionByTaskId.get(execution.taskId);
    if (!session?.interactions) continue;

    let interactions: any[] = [];
    try {
      const parsed = JSON.parse(session.interactions);
      if (Array.isArray(parsed)) interactions = parsed;
    } catch {}
    if (interactions.length === 0) continue;

    const registrations = extractObservedAgentRegistrations(interactions, execution.agentName);
    for (const registration of registrations) {
      const agentUser = execution.user || null;
      const key = `${platform}\u0000${registration.name}\u0000${agentUser || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const existing = await (prismaRaw as any).registeredAgent.findFirst({
        where: { platform, name: registration.name, user: agentUser },
      });
      if (existing) continue;

      try {
        await (prismaRaw as any).registeredAgent.create({
          data: {
            platform,
            name: registration.name,
            user: agentUser,
            agentType: registration.agentType,
            agentOwnership: 'unregistered',
          },
        });
      } catch {
        // Another request may have registered the same observed agent first.
      }
    }
  }
}

/**
 * Agent 管理页的列表接口。
 *
 * Response shape (与 src/app/(main)/agents/page.tsx fetchDbAgents 期望对齐):
 *   {
 *     agents: [
 *       { id, platform, name, description, agentType, agentOwnership,
 *         createdAt, todayCalls, lastExecutedAt }
 *     ]
 *   }
 *
 * 用法约定：
 *   - 不传 user：返回所有 agent（系统 + 用户的）
 *   - 传 user：返回 (user 自己的) + (user=null 即系统 agent)
 *   - todayCalls / lastExecutedAt 来自 Execution 表的聚合（按 agentId）
 */
export async function GET(request: Request) {
  try {
    // 每次列表请求都确保系统 Agent 已注册/更新（promote unregistered -> system）
    await ensureAllSystemAgents();

    const { searchParams } = new URL(request.url);
    const user = (searchParams.get('user') || '').trim() || undefined;

    await backfillObservedAgentsFromSessions(user);

    const where = user
      ? { OR: [{ user }, { user: null }] }
      : {};

    const rows = await (prismaRaw as any).registeredAgent.findMany({
      where,
      orderBy: [{ agentOwnership: 'asc' }, { createdAt: 'desc' }],
    });

    // 内存中去重：如果同名+同平台的 Agent 中存在 'system'，则隐藏该名下的 'unregistered'
    // 这种情况通常发生在 Trace 先上报产生未注册记录，随后代码中加入了系统 Agent 定义。
    const systemKeys = new Set(
      rows.filter((r: any) => r.agentOwnership === 'system').map((r: any) => `${r.platform}-${r.name}`)
    );
    const filteredRows = rows.filter((r: any) => {
      if (r.agentOwnership === 'unregistered' && systemKeys.has(`${r.platform}-${r.name}`)) {
        return false;
      }
      return true;
    });

    // 聚合每个 agent 的 trace 指标。一次性查所有 agentId，避免 N+1。
    const agentIds = filteredRows.map((r: { id: string }) => r.id);
    let executions: Array<{ agentId: string | null; timestamp: Date | null }> = [];
    if (agentIds.length > 0) {
      executions = await (prismaRaw as any).execution.findMany({
        where: { agentId: { in: agentIds } },
        select: { agentId: true, timestamp: true },
      });
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();

    const stats = new Map<string, { todayCalls: number; lastExecutedAt: Date | null }>();
    for (const exec of executions) {
      if (!exec.agentId) continue;
      const cur = stats.get(exec.agentId) || { todayCalls: 0, lastExecutedAt: null };
      const ts = exec.timestamp ? new Date(exec.timestamp) : null;
      if (ts && ts.getTime() >= todayMs) cur.todayCalls += 1;
      if (ts && (!cur.lastExecutedAt || ts > cur.lastExecutedAt)) cur.lastExecutedAt = ts;
      stats.set(exec.agentId, cur);
    }

    const agents = filteredRows.map((r: any) => {
      const s = stats.get(r.id) || { todayCalls: 0, lastExecutedAt: null };
      return {
        id: r.id,
        platform: r.platform,
        name: r.name,
        description: r.description ?? '',
        agentType: r.agentType,
        agentOwnership: r.agentOwnership,
        user: r.user,
        createdAt: r.createdAt,
        todayCalls: String(s.todayCalls),
        lastExecutedAt: s.lastExecutedAt ? s.lastExecutedAt.toISOString() : r.createdAt,
      };
    });

    return NextResponse.json({ agents });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[agents] GET error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * 用户手工注册一个 agent（前端"注册 Agent"对话框走这条）。
 * 系统 agent 由服务启动时 instrumentation 自动注册，不走这里。
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const platform = String(body?.platform || '').trim();
    const name = String(body?.name || '').trim();
    const description = String(body?.description || '').trim();
    const user = body?.user ? String(body.user).trim() : null;

    if (!platform || !name) {
      return NextResponse.json(
        { error: 'platform and name are required' },
        { status: 400 },
      );
    }

    const existing = await (prismaRaw as any).registeredAgent.findFirst({
      where: { platform, name, user },
    });
    if (existing) {
      // 已存在则把状态升级为 user-registered（auto-discovered → user 主动确认）
      const updated = await (prismaRaw as any).registeredAgent.update({
        where: { id: existing.id },
        data: {
          agentOwnership: existing.agentOwnership === 'system' ? 'system' : 'user',
          ...(description ? { description } : {}),
        },
      });
      return NextResponse.json({ agent: updated });
    }

    const created = await (prismaRaw as any).registeredAgent.create({
      data: {
        platform,
        name,
        user,
        description,
        agentType: 'main',
        agentOwnership: 'user',
      },
    });
    return NextResponse.json({ agent: created });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[agents] POST error:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
