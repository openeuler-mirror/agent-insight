// 触发实验执行：置 running + 逐行异步执行（fire-and-forget），立即返回当前状态。
// 按 type 分流：type='llm' → startComparisonRun；type='single' → startExperimentRun（G4 保持 200+alreadyRunning）。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { startExperimentRun } from '@/lib/engine/experiment/run-experiment';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { startComparisonRun } from '@/lib/engine/experiment/comparison-runner';
import { prisma } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    // 按 type 分流
    const exp = await prisma.experiment.findUnique({ where: { id }, select: { type: true } });
    if (!exp) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }

    const result = exp.type === 'llm'
      ? await startComparisonRun(id, username)
      : await startExperimentRun(id, username);
    if (!result) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }
    // 执行在后台继续；错误已在引擎内逐行落库
    result.completion?.catch((e) => {
      console.error('[Experiment Run Error]', e);
    });
    // 只在真正创建了一次实验时计数；命中"已在运行"是同一次用户意图，不重复计。
    if (!result.alreadyRunning) {
      recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.run' });
    }

    return NextResponse.json({
      status: result.status,
      ...(result.alreadyRunning ? { alreadyRunning: true } : {}),
    });
  } catch (error) {
    console.error('[Experiment Run Error]', error);
    return NextResponse.json({ error: 'Failed to start experiment run' }, { status: 500 });
  }
}
