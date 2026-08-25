// 触发实验执行：置 running + 逐行异步执行（fire-and-forget），立即返回当前状态。
// type='llm' 走对比执行；type='single' 可选生成 Trace/FI 后再走单组执行。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { startExperimentRun } from '@/lib/engine/experiment/run-experiment';
import {
  awaitFiSessionsAndBindExperimentCases,
  collectFiCasesFromExperiment,
  FiOrchestrateError,
  orchestrateFaultInjection,
} from '@/lib/engine/experiment/fi-orchestrate';
import {
  assertTraceGenerationTarget,
  collectTraceGenerationCases,
  generateExperimentTraces,
  TraceGenerationError,
} from '@/lib/engine/experiment/trace-generation';
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

    const currentExperiment = await prisma.experiment.findFirst({
      where: { id, user: username },
      select: { status: true, type: true },
    });
    if (!currentExperiment) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }
    if (currentExperiment.status === 'running') {
      return NextResponse.json({ status: 'running', alreadyRunning: true });
    }

    if (currentExperiment.type === 'llm') {
      const comparisonResult = await startComparisonRun(id, username);
      if (!comparisonResult) {
        return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
      }
      comparisonResult.completion?.catch((error) => {
        console.error('[Experiment Run Error]', error);
      });
      if (!comparisonResult.alreadyRunning) {
        recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.run' });
      }
      return NextResponse.json({
        status: comparisonResult.status,
        ...(comparisonResult.alreadyRunning ? { alreadyRunning: true } : {}),
      });
    }

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    // generate Trace 的运行参数；普通数据走通用客户端指令，可靠性数据才走 FI。
    const generateTrace = (body.generateTrace && typeof body.generateTrace === 'object')
      ? body.generateTrace as Record<string, unknown>
      : null;
    const wantGenerate = body.traceSource === 'generate' || Boolean(generateTrace);
    const wantFi = body.fiOrchestrate === true;

    if (wantGenerate && !wantFi) {
      const cases = await collectTraceGenerationCases(id);
      if (!cases.length) {
        return NextResponse.json(
          { error: '没有可生成 Trace 的 Case，未启动评估' },
          { status: 409 },
        );
      }
      const workerId = String(generateTrace?.workerId || '').trim();
      const platform = String(generateTrace?.platform || body.platform || 'opencode').trim();
      const experiment = await prisma.experiment.findFirst({
        where: { id, user: username },
        select: { agentName: true },
      });
      const agent = String(generateTrace?.agent || experiment?.agentName || '').trim();
      await assertTraceGenerationTarget({ user: username, workerId, platform, agent });
      const timeoutSeconds = typeof generateTrace?.timeoutSeconds === 'number'
        ? generateTrace.timeoutSeconds
        : 180;

      await prisma.experiment.updateMany({
        where: { id, user: username },
        data: { status: 'running' },
      });
      recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.run' });
      void (async () => {
        try {
          const generated = await generateExperimentTraces({
            user: username,
            experimentId: id,
            workerId,
            platform,
            agent,
            model: generateTrace?.model != null ? String(generateTrace.model) : null,
            timeoutSeconds,
            cases,
          });
          if (!generated.readyCaseIds.length) {
            await prisma.experiment.updateMany({
              where: { id, user: username },
              data: { status: 'failed' },
            });
            return;
          }
          const result = await startExperimentRun(id, username, {
            allowPersistedRunning: true,
            caseIds: generated.readyCaseIds,
          });
          await result?.completion?.catch((error) => {
            console.error('[Experiment Run Error]', error);
          });
        } catch (error) {
          console.error('[experiment-run] trace generation/start failed', error);
          await prisma.experiment.updateMany({
            where: { id, user: username },
            data: { status: 'failed' },
          }).catch(() => undefined);
        }
      })();
      return NextResponse.json({
        status: 'running',
        awaitingTraceGeneration: true,
        traceGeneration: { total: cases.length },
      });
    }

    let fi: Awaited<ReturnType<typeof orchestrateFaultInjection>> | null = null;
    if (wantFi) {
      const cases = await collectFiCasesFromExperiment(id);
      if (cases.length) {
        const experiment = await prisma.experiment.findFirst({
          where: { id, user: username },
          select: { agentName: true },
        });
        const timeoutSeconds = typeof generateTrace?.timeoutSeconds === 'number'
          ? generateTrace.timeoutSeconds
          : 180;
        fi = await orchestrateFaultInjection({
          user: username,
          experimentId: id,
          platform: String(generateTrace?.platform || body.platform || 'opencode'),
          agent: String(generateTrace?.agent || experiment?.agentName || 'default'),
          model: generateTrace?.model != null ? String(generateTrace.model) : null,
          targetWorkerId: generateTrace?.workerId != null ? String(generateTrace.workerId) : null,
          workspace: generateTrace?.workspace != null ? String(generateTrace.workspace) : null,
          timeoutSeconds,
          cases,
        });

        // 设计契约：FI → 对齐 sessionTaskId/Case.taskId → 再评测。
        // 等待放后台，避免 HTTP 阻塞数分钟；勿在空轨迹上立刻 Judge。
        if (fi && !fi.skipped && fi.runIds.length) {
          const waitMs = Math.max(60_000, (timeoutSeconds + 180) * 1000);
          const runIds = fi.runIds;
          await prisma.experiment.updateMany({
            where: { id, user: username },
            data: { status: 'running' },
          });
          recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.run' });
          void (async () => {
            try {
              const bound = await awaitFiSessionsAndBindExperimentCases({
                runIds,
                timeoutMs: waitMs,
              });
              if (bound.pendingRunIds.length || bound.failedRunIds.length) {
                console.warn('[experiment-run] FI session bind incomplete', {
                  experimentId: id,
                  bound: bound.bound,
                  ready: bound.readyRunIds.length,
                  pending: bound.pendingRunIds,
                  failed: bound.failedRunIds,
                });
              }
              const readyRunIds = new Set(bound.readyRunIds);
              const readyCaseIds = fi.caseFaults
                .filter((item) => item.runId && readyRunIds.has(item.runId))
                .map((item) => item.caseId);
              if (!readyCaseIds.length) {
                await prisma.experiment.updateMany({
                  where: { id, user: username },
                  data: { status: 'failed' },
                });
                return;
              }
              const result = await startExperimentRun(id, username, {
                allowPersistedRunning: true,
                caseIds: readyCaseIds,
              });
              if (!result) return;
              await result.completion?.catch((e) => {
                console.error('[Experiment Run Error]', e);
              });
            } catch (e) {
              console.error('[experiment-run] FI await/start failed', e);
              try {
                await prisma.experiment.update({
                  where: { id },
                  data: { status: 'failed' },
                });
              } catch {
                /* ignore */
              }
            }
          })();
          return NextResponse.json({
            status: 'running',
            awaitingFiSession: true,
            fiOrchestrate: fi,
          });
        }
        await prisma.experiment.updateMany({
          where: { id, user: username },
          data: { status: 'failed' },
        });
        return NextResponse.json(
          { error: 'Trace 生成任务未成功创建，未启动评估' },
          { status: 503 },
        );
      } else {
        return NextResponse.json(
          { error: '没有可生成 Trace 的 Case，未启动评估' },
          { status: 409 },
        );
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
    if (error instanceof TraceGenerationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
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
