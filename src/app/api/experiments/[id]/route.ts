// 实验详情：实验 + cases。results 现阶段恒为空数组（执行引擎后续里程碑写入）。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));

    const experiment = await prisma.experiment.findFirst({
      where: { id, ...(username ? { user: username } : {}) },
      include: { cases: { orderBy: { createdAt: 'asc' } } },
    });
    if (!experiment) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }

    let evaluatorIds: string[] = [];
    try {
      const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
      if (Array.isArray(parsed)) evaluatorIds = parsed.map(String);
    } catch { /* 忽略脏数据 */ }

    return NextResponse.json({
      id: experiment.id,
      name: experiment.name,
      type: experiment.type,
      agentName: experiment.agentName,
      status: experiment.status,
      evaluatorIds,
      createdAt: experiment.createdAt,
      cases: experiment.cases.map((c: any) => ({
        id: c.id,
        executionId: c.executionId,
        taskId: c.taskId,
        input: c.input,
        actualOutput: c.actualOutput,
        referenceOutput: c.referenceOutput,
      })),
      // 执行引擎未接入：详情先恒空，字段留位。
      results: [],
    });
  } catch (error) {
    console.error('[Experiment Detail Error]', error);
    return NextResponse.json({ error: 'Failed to load experiment' }, { status: 500 });
  }
}
