// 触发实验执行：可选外挂 FI 编排，再交给 startExperimentRun（内核不写 Worker I/O）。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { startExperimentRun } from '@/lib/engine/experiment/run-experiment';
import {
  collectFiCasesFromExperiment,
  FiOrchestrateError,
  orchestrateFaultInjection,
} from '@/lib/engine/experiment/fi-orchestrate';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
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

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // IF-M03 外挂：generateTrace / fi 参数存在时先创建 FI 任务（Worker 过渡路径）。
    const generateTrace = (body.generateTrace && typeof body.generateTrace === 'object')
      ? body.generateTrace as Record<string, unknown>
      : null;
    const wantFi =
      body.fiOrchestrate === true ||
      body.traceSource === 'generate' ||
      Boolean(generateTrace);

    let fi: Awaited<ReturnType<typeof orchestrateFaultInjection>> | null = null;
    if (wantFi) {
      const cases = await collectFiCasesFromExperiment(id);
      if (cases.length) {
        const experiment = await prisma.experiment.findFirst({
          where: { id, user: username },
          select: { agentName: true },
        });
        fi = await orchestrateFaultInjection({
          user: username,
          experimentId: id,
          platform: String(generateTrace?.platform || body.platform || 'opencode'),
          agent: String(generateTrace?.agent || experiment?.agentName || 'default'),
          model: generateTrace?.model != null ? String(generateTrace.model) : null,
          workspace: generateTrace?.workspace != null ? String(generateTrace.workspace) : null,
          timeoutSeconds: typeof generateTrace?.timeoutSeconds === 'number'
            ? generateTrace.timeoutSeconds
            : 180,
          cases,
        });
      }
    }

    const result = await startExperimentRun(id, username);
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
      ...(fi ? { fiOrchestrate: fi } : {}),
    });
  } catch (error) {
    if (error instanceof FiOrchestrateError) {
      return NextResponse.json(
        { error: error.message, code: error.code, fiOrchestrate: { skipped: false, reason: error.code } },
        { status: error.httpStatus },
      );
    }
    console.error('[Experiment Run Error]', error);
    return NextResponse.json({ error: 'Failed to start experiment run' }, { status: 500 });
  }
}
