// 实验向导 ① 步：候选 Agent 下拉 —— distinct Execution.agentName（root trace），按出现次数降序。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { buildExecutionOwnershipWhere } from '@/lib/agent-ownership';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    const userFilter = username ? { user: username } : {};
    const userOwnershipWhere = await buildExecutionOwnershipWhere('user');

    const grouped = await prisma.execution.groupBy({
      by: ['agentName'],
      where: {
        ...userFilter,
        isSubagent: false,
        agentName: { not: null },
        AND: [userOwnershipWhere],
      },
      _count: { agentName: true },
      orderBy: { _count: { agentName: 'desc' } },
      take: 50,
    });

    const agents = grouped
      .filter((g: any) => (g.agentName || '').trim() !== '')
      .map((g: any) => ({ name: g.agentName as string, traces: g._count.agentName as number }));

    return NextResponse.json({ agents });
  } catch (error) {
    console.error('[Experiment Agents Error]', error);
    return NextResponse.json({ error: 'Failed to load agents' }, { status: 500 });
  }
}
