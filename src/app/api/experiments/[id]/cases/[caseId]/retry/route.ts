import { NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  awaitFiSessionsAndBindExperimentCases,
  orchestrateFaultInjection,
} from '@/lib/engine/experiment/fi-orchestrate';
import {
  retryResultRow,
  startEvalExperimentCases,
} from '@/lib/engine/experiment/run-experiment';
import {
  assertTraceGenerationTarget,
  generateExperimentTraces,
  loadTraceGenerationRetryRequest,
  TraceGenerationError,
} from '@/lib/engine/experiment/trace-generation';
import { prisma } from '@/lib/storage/prisma';

export const dynamic = 'force-dynamic';

const CASE_RETRY_SET = Symbol.for('agent-insight.experiment-case-retry-set');

function retrySet(): Set<string> {
  const globalState = globalThis as typeof globalThis & { [CASE_RETRY_SET]?: Set<string> };
  if (!globalState[CASE_RETRY_SET]) globalState[CASE_RETRY_SET] = new Set<string>();
  return globalState[CASE_RETRY_SET];
}

function parseObject(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function settleAfterTraceRetryFailure(experimentId: string): Promise<void> {
  const completed = await prisma.experimentEvalResult.count({
    where: { experimentId, status: 'done' },
  });
  await prisma.experiment.updateMany({
    where: { id: experimentId },
    data: { status: completed > 0 ? 'done' : 'failed' },
  });
}

async function prepareGeneratedTraceRetry(experimentId: string, caseId: string): Promise<void> {
  await prisma.$transaction([
    prisma.experimentCase.update({
      where: { id: caseId },
      data: {
        executionId: null,
        taskId: null,
        actualOutput: '',
        traceGenerationError: null,
      },
    }),
    prisma.experimentEvalResult.updateMany({
      where: { experimentId, caseId },
      data: {
        status: 'pending',
        verdict: null,
        summary: null,
        score: null,
        pointsJson: null,
        evidenceJson: null,
        errorMessage: null,
        attempts: 0,
        durationMs: null,
        humanScore: null,
        humanReason: null,
        humanBy: null,
        humanAt: null,
      },
    }),
    prisma.experiment.update({ where: { id: experimentId }, data: { status: 'running' } }),
  ]);
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> },
) {
  const { id, caseId } = await params;
  const url = new URL(req.url);
  const { username } = await resolveUser(req, url.searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

  const lockKey = `${username}:${id}:${caseId}`;
  const active = retrySet();
  if (active.has(lockKey)) {
    return NextResponse.json({ error: '该 Case 正在重试', code: 'case_retry_in_progress' }, { status: 409 });
  }
  active.add(lockKey);
  let backgroundOwnsLock = false;

  try {
    const row = await prisma.experimentCase.findFirst({
      where: { id: caseId, experimentId: id, experiment: { user: username } },
      select: {
        id: true,
        input: true,
        executionId: true,
        faultInjectionType: true,
        fiTaskId: true,
        fiRunId: true,
        traceGenerationCommandId: true,
        traceAttempts: { take: 1, select: { id: true } },
        results: {
          select: { id: true, status: true },
        },
      },
    });
    if (!row) return NextResponse.json({ error: 'case not found' }, { status: 404 });
    if (row.results.some((result: { status: string }) => (
      result.status === 'pending' || result.status === 'running'
    ))) {
      return NextResponse.json({ error: '该 Case 正在评估' }, { status: 409 });
    }

    const isGenericGeneratedTrace = Boolean(
      row.traceGenerationCommandId || row.traceAttempts.length,
    );
    const genericRequest = isGenericGeneratedTrace
      ? await loadTraceGenerationRetryRequest({
          user: username,
          experimentId: id,
          caseId,
        })
      : null;
    if (genericRequest) {
      await assertTraceGenerationTarget(genericRequest);
      await prepareGeneratedTraceRetry(id, caseId);
      backgroundOwnsLock = true;
      void (async () => {
        try {
          const generated = await generateExperimentTraces(genericRequest, { forceNewTrace: true });
          if (!generated.readyCaseIds.length) {
            await settleAfterTraceRetryFailure(id);
            return;
          }
          const evaluation = await startEvalExperimentCases(id, generated.readyCaseIds, username);
          await evaluation?.completion;
        } catch (error) {
          console.error('[experiment-case-retry] trace retry failed', error);
          await settleAfterTraceRetryFailure(id).catch(() => undefined);
        } finally {
          active.delete(lockKey);
        }
      })();
      return NextResponse.json({ kind: 'trace', status: 'running' });
    }

    if (row.fiTaskId && row.fiRunId && row.faultInjectionType) {
      const [task, previousRun] = await Promise.all([
        prisma.faultInjectionTask.findFirst({
          where: { id: row.fiTaskId, user: username },
          select: { platform: true, agent: true, model: true, workspace: true, requestJson: true },
        }),
        prisma.faultInjectionRun.findFirst({
          where: {
            user: username,
            OR: [{ id: row.fiRunId }, { runId: row.fiRunId }],
          },
          select: { requestJson: true, submode: true, status: true },
        }),
      ]);
      if (!task || !previousRun) {
        return NextResponse.json({ error: '找不到上次 Trace 生成配置' }, { status: 409 });
      }
      if (['queued', 'collecting', 'judging'].includes(previousRun.status)) {
        return NextResponse.json({ error: '该 Case 正在生成 Trace' }, { status: 409 });
      }
      const taskRequest = parseObject(task.requestJson);
      const runRequest = parseObject(previousRun.requestJson);
      const timeoutSeconds = Number(runRequest.timeoutSeconds ?? taskRequest.timeoutSeconds) || 180;
      const targetWorkerId = typeof runRequest.targetWorkerId === 'string'
        ? runRequest.targetWorkerId
        : null;
      const fi = await orchestrateFaultInjection({
        user: username,
        experimentId: id,
        platform: task.platform,
        agent: task.agent,
        model: task.model,
        targetWorkerId,
        workspace: task.workspace,
        timeoutSeconds,
        cases: [{
          caseId,
          input: row.input,
          fault: row.faultInjectionType,
          submode: previousRun.submode,
        }],
      });
      if (fi.skipped || !fi.runIds.length) {
        return NextResponse.json({ error: 'Trace 重试任务创建失败' }, { status: 503 });
      }
      await prepareGeneratedTraceRetry(id, caseId);
      backgroundOwnsLock = true;
      void (async () => {
        try {
          const bound = await awaitFiSessionsAndBindExperimentCases({
            runIds: fi.runIds,
            timeoutMs: Math.max(60_000, (timeoutSeconds + 180) * 1_000),
          });
          const ready = new Set(bound.readyRunIds);
          const readyCaseIds = fi.caseFaults
            .filter((item) => item.runId && ready.has(item.runId))
            .map((item) => item.caseId);
          if (!readyCaseIds.length) {
            await settleAfterTraceRetryFailure(id);
            return;
          }
          const evaluation = await startEvalExperimentCases(id, readyCaseIds, username);
          await evaluation?.completion;
        } catch (error) {
          console.error('[experiment-case-retry] FI retry failed', error);
          await settleAfterTraceRetryFailure(id).catch(() => undefined);
        } finally {
          active.delete(lockKey);
        }
      })();
      return NextResponse.json({ kind: 'trace', status: 'running' });
    }

    if (row.executionId) {
      const failedResults = row.results.filter(
        (result: { id: string; status: string }) => result.status === 'failed',
      );
      if (!failedResults.length) {
        return NextResponse.json({ error: '该 Case 没有失败的评估结果' }, { status: 409 });
      }
      const statuses = [];
      for (const result of failedResults) {
        statuses.push(await retryResultRow(id, result.id, username));
      }
      return NextResponse.json({
        kind: 'evaluation',
        status: statuses.every((status) => status === 'done') ? 'done' : 'failed',
      });
    }

    return NextResponse.json({ error: '该 Case 没有可重试的失败项' }, { status: 409 });
  } catch (error) {
    if (error instanceof TraceGenerationError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.httpStatus },
      );
    }
    console.error('[Experiment Case Retry Error]', error);
    return NextResponse.json({ error: 'Case 重试失败' }, { status: 500 });
  } finally {
    if (!backgroundOwnsLock) active.delete(lockKey);
  }
}
