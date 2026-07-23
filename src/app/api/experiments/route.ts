// 评测「实验」API —— 列表 + 创建（本期仅单组实验 type='single'）。
// 执行引擎（ExperimentEvalResult 写入）为后续里程碑，POST 仅落 draft。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

interface CaseInput {
  executionId?: string;
  taskId?: string;
  input?: string;
  actualOutput?: string;
  referenceOutput?: string | null;
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    const userFilter = username ? { user: username } : {};

    const rows = await prisma.experiment.findMany({
      where: userFilter,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { cases: true } } },
    });

    const items = rows.map((r: any) => {
      let evaluatorCount = 0;
      try {
        const ids = JSON.parse(r.evaluatorIdsJson || '[]');
        evaluatorCount = Array.isArray(ids) ? ids.length : 0;
      } catch { /* 忽略脏数据 */ }
      return {
        id: r.id,
        name: r.name,
        type: r.type,
        agentName: r.agentName,
        status: r.status,
        caseCount: r._count.cases,
        evaluatorCount,
        createdAt: r.createdAt,
      };
    });

    return NextResponse.json({ items });
  } catch (error) {
    console.error('[Experiments GET Error]', error);
    return NextResponse.json({ error: 'Failed to load experiments' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { username } = await resolveUser(req, body.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const name = String(body.name || '').trim();
    const agentName = String(body.agentName || '').trim();
    const watchMode = body.watchMode === true;
    const cases: CaseInput[] = Array.isArray(body.cases) ? body.cases : [];
    const evaluatorIds: string[] = Array.isArray(body.evaluatorIds)
      ? body.evaluatorIds.map((id: unknown) => String(id)).filter(Boolean)
      : [];

    if (!name) {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }
    // 监听模式允许 0 条 case 起步（纯监听，后续该 Agent 新 trace 自动进来评）
    if (!watchMode && cases.length < 1) {
      return NextResponse.json({ error: 'at least one case is required' }, { status: 400 });
    }
    if (watchMode && !agentName) {
      return NextResponse.json({ error: 'watch mode requires agentName' }, { status: 400 });
    }
    if (evaluatorIds.length < 1) {
      return NextResponse.json({ error: 'at least one evaluator is required' }, { status: 400 });
    }

    const experiment = await prisma.experiment.create({
      data: {
        user: username,
        name,
        type: 'single',
        agentName,
        evaluatorIdsJson: JSON.stringify(evaluatorIds),
        status: 'draft',
        watchMode,
        watchEnabledAt: watchMode ? new Date() : null,
        cases: {
          create: cases.map((c) => ({
            executionId: c.executionId ? String(c.executionId) : null,
            taskId: c.taskId ? String(c.taskId) : null,
            input: String(c.input ?? ''),
            actualOutput: String(c.actualOutput ?? ''),
            referenceOutput:
              c.referenceOutput != null && String(c.referenceOutput).trim() !== ''
                ? String(c.referenceOutput)
                : null,
          })),
        },
      },
      select: { id: true },
    });

    return NextResponse.json({ id: experiment.id });
  } catch (error) {
    console.error('[Experiments POST Error]', error);
    return NextResponse.json({ error: 'Failed to create experiment' }, { status: 500 });
  }
}
