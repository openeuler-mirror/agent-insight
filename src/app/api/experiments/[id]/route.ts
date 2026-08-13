// 实验详情：实验元信息 + 服务端聚合（整体均分 overall / 评估器分解 breakdown /
// 进度 progress，均由全量结果算出）+ 服务端分页的 case 列表（cases 及其 results，
// 仅当前页）。case 多（尤其监听实验会持续累积）时不再一次拉全量。
import { NextResponse } from 'next/server';
import type { ExperimentCase, ExperimentEvalResult } from '@prisma/client';
import {
  extractLegacyFiFromEvaluatorContextJson,
  parseExperimentCaseEvaluatorContext,
} from '@/lib/engine/experiment/case-fi-meta';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { overallAverage, evaluatorBreakdown } from '@/lib/engine/experiment/detail-agg';
import { hasUsableTraceInteractions } from '@/lib/engine/experiment/fi-orchestrate';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

export const dynamic = 'force-dynamic';

function parseJsonValue(value: string | null): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

type GeneratedTraceStatus = 'pending' | 'ready' | 'failed';

function deriveGeneratedTraceStatus(input: {
  usable: boolean;
  runStatus?: string | null;
  experimentStatus: string;
}): GeneratedTraceStatus {
  if (input.usable) return 'ready';
  if (input.runStatus === 'failed' || input.runStatus === 'stopped') return 'failed';
  if (input.experimentStatus === 'failed' || input.experimentStatus === 'done') return 'failed';
  return 'pending';
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const url = new URL(req.url);
    const q = url.searchParams;
    const { username } = await resolveUser(req, q.get('user'));
    const casePageSize = Math.min(Math.max(Number(q.get('casePageSize')) || 20, 1), 100);
    const casePageRaw = Math.max(Number(q.get('casePage')) || 1, 1);
    // caseId：精确取单条 case（Trace 评测详情页下钻用，绕过 case 列表分页）
    const wantCaseId = q.get('caseId') || '';

    const experiment = await prisma.experiment.findFirst({
      where: { id, ...(username ? { user: username } : {}) },
      select: {
        id: true, name: true, type: true, agentName: true, status: true,
        watchMode: true, watchEnabledAt: true, evaluatorIdsJson: true, createdAt: true,
      },
    });
    if (!experiment) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }

    let evaluatorIds: string[] = [];
    try {
      const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
      if (Array.isArray(parsed)) evaluatorIds = parsed.map(String);
    } catch { /* 忽略脏数据 */ }

    // 聚合口径按全量结果算（轻量选列，不取 points/evidence）。
    // humanScore 必须一起取——聚合走生效分（humanScore ?? score），漏了它人工修正就不生效。
    const allResults = await prisma.experimentEvalResult.findMany({
      where: { experimentId: id },
      select: { caseId: true, evaluatorId: true, status: true, score: true, humanScore: true },
    });
    // case 列表服务端分页（每页 case 连同其 results 一起返回，供逐 case 得分/重评）；
    // 指定 caseId 时只取该单条（下钻详情用，不受分页影响）。
    const caseTotal = await prisma.experimentCase.count({ where: { experimentId: id } });
    const casePages = Math.max(1, Math.ceil(caseTotal / casePageSize));
    const casePage = Math.min(casePageRaw, casePages);
    const pagedCases = await prisma.experimentCase.findMany({
      where: wantCaseId ? { id: wantCaseId, experimentId: id } : { experimentId: id },
      orderBy: { createdAt: 'asc' },
      ...(wantCaseId ? {} : { skip: (casePage - 1) * casePageSize, take: casePageSize }),
      include: { results: { orderBy: { createdAt: 'asc' } } },
    }) as Array<ExperimentCase & { results: ExperimentEvalResult[] }>;

    const generatedCases = await prisma.experimentCase.findMany({
      where: { experimentId: id, fiRunId: { not: null } },
      select: { id: true, executionId: true, taskId: true, fiRunId: true },
    }) as Array<{ id: string; executionId: string | null; taskId: string | null; fiRunId: string | null }>;
    const fiRunKeys = Array.from(new Set(
      generatedCases.map((item) => item.fiRunId).filter((value): value is string => Boolean(value)),
    ));
    const generatedUserWhere = username ? { user: username } : {};
    const fiRuns = (fiRunKeys.length
      ? await prisma.faultInjectionRun.findMany({
        where: {
          ...generatedUserWhere,
          OR: [{ id: { in: fiRunKeys } }, { runId: { in: fiRunKeys } }],
        },
        select: { id: true, runId: true, status: true, sessionTaskId: true, error: true },
      })
      : []) as Array<{
        id: string;
        runId: string;
        status: string;
        sessionTaskId: string | null;
        error: string | null;
      }>;
    const fiRunByKey = new Map<string, typeof fiRuns[number]>();
    for (const run of fiRuns) {
      fiRunByKey.set(run.id, run);
      fiRunByKey.set(run.runId, run);
    }
    const generatedTaskIds = Array.from(new Set(
      generatedCases
        .map((item) => item.taskId || (item.fiRunId ? fiRunByKey.get(item.fiRunId)?.sessionTaskId : null))
        .filter((value): value is string => Boolean(value)),
    ));
    const [generatedExecutionsRaw, generatedSessionsRaw] = await Promise.all([
      generatedTaskIds.length
        ? prisma.execution.findMany({
          where: { ...generatedUserWhere, taskId: { in: generatedTaskIds }, isSubagent: false },
          orderBy: { timestamp: 'desc' },
          select: { id: true, taskId: true, query: true, finalResult: true },
        })
        : [],
      generatedTaskIds.length
        ? prisma.session.findMany({
          where: { ...generatedUserWhere, taskId: { in: generatedTaskIds } },
          select: { taskId: true, interactions: true },
        })
        : [],
    ]);
    const generatedExecutions = generatedExecutionsRaw as Array<{
      id: string;
      taskId: string | null;
      query: string | null;
      finalResult: string | null;
    }>;
    const generatedSessions = generatedSessionsRaw as Array<{
      taskId: string;
      interactions: string | null;
    }>;
    const generatedExecutionByTask = new Map<string, typeof generatedExecutions[number]>();
    for (const execution of generatedExecutions) {
      if (execution.taskId && !generatedExecutionByTask.has(execution.taskId)) {
        generatedExecutionByTask.set(execution.taskId, execution);
      }
    }
    const generatedSessionByTask = new Map(
      generatedSessions.map((session) => [session.taskId, session]),
    );
    const traceStateByCase = new Map<string, {
      status: GeneratedTraceStatus;
      error: string | null;
      taskId: string | null;
      executionId: string | null;
    }>();
    for (const item of generatedCases) {
      const run = item.fiRunId ? fiRunByKey.get(item.fiRunId) : undefined;
      const taskId = item.taskId || run?.sessionTaskId || null;
      const execution = taskId ? generatedExecutionByTask.get(taskId) : undefined;
      const session = taskId ? generatedSessionByTask.get(taskId) : undefined;
      const usable = Boolean(execution && hasUsableTraceInteractions(session?.interactions));
      const status = deriveGeneratedTraceStatus({
        usable,
        runStatus: run?.status,
        experimentStatus: experiment.status,
      });
      traceStateByCase.set(item.id, {
        status,
        error: status === 'failed'
          ? (run?.error || 'Trace 未上报、轨迹为空或等待超时')
          : null,
        taskId,
        executionId: item.executionId || execution?.id || null,
      });
    }
    const traceStates = Array.from(traceStateByCase.values());
    const traceProgress = traceStates.length ? {
      total: traceStates.length,
      ready: traceStates.filter((item) => item.status === 'ready').length,
      failed: traceStates.filter((item) => item.status === 'failed').length,
      pending: traceStates.filter((item) => item.status === 'pending').length,
    } : null;
    const invalidGeneratedCaseIds = new Set(
      Array.from(traceStateByCase.entries())
        .filter(([, state]) => state.status !== 'ready')
        .map(([caseId]) => caseId),
    );
    const effectiveAllResults = allResults.filter(
      (result: { caseId: string }) => !invalidGeneratedCaseIds.has(result.caseId),
    );
    const progress = {
      total: effectiveAllResults.length,
      done: effectiveAllResults.filter((r: { status: string }) => r.status === 'done').length,
      failed: effectiveAllResults.filter((r: { status: string }) => r.status === 'failed').length,
      pending: effectiveAllResults.filter((r: { status: string }) => r.status === 'pending' || r.status === 'running').length,
    };
    const overall = overallAverage(effectiveAllResults);
    const breakdown = evaluatorBreakdown(effectiveAllResults);

    // input/actualOutput 兜底：trace/监听模式建的 case 这两字段存空，从对应 Execution
    // 的 query/finalResult 兜底（与评估时 loadCaseRuntime 口径一致），否则详情页显示为 "-"。
    const needExecTaskIds = Array.from(new Set(
      pagedCases
        .map((c) => c.taskId || traceStateByCase.get(c.id)?.taskId)
        .filter((taskId): taskId is string => Boolean(taskId)),
    ));
    const execFallback = new Map<string, { query: string; finalResult: string }>();
    if (needExecTaskIds.length) {
      const execs = await prisma.execution.findMany({
        where: { taskId: { in: needExecTaskIds } },
        orderBy: { timestamp: 'desc' },
        select: { taskId: true, query: true, finalResult: true },
      });
      for (const e of execs) {
        if (e.taskId && !execFallback.has(e.taskId)) {
          execFallback.set(e.taskId, { query: e.query || '', finalResult: e.finalResult || '' });
        }
      }
    }

    const results = pagedCases.flatMap((c) =>
      (invalidGeneratedCaseIds.has(c.id) ? [] : c.results).map((r) => ({
        id: r.id,
        caseId: r.caseId,
        evaluatorId: r.evaluatorId,
        status: r.status,
        verdict: r.verdict,
        summary: r.summary,
        score: r.score,
        points: parseJsonValue(r.pointsJson),
        evidence: parseJsonValue(r.evidenceJson),
        humanScore: r.humanScore,
        humanReason: r.humanReason,
        humanBy: r.humanBy,
        humanAt: r.humanAt,
        errorMessage: r.errorMessage,
        attempts: r.attempts,
        durationMs: r.durationMs,
      })),
    );

    return NextResponse.json({
      id: experiment.id,
      name: experiment.name,
      type: experiment.type,
      agentName: experiment.agentName,
      status: experiment.status,
      watchMode: experiment.watchMode,
      watchEnabledAt: experiment.watchEnabledAt,
      evaluatorIds,
      createdAt: experiment.createdAt,
      overall,
      breakdown,
      cases: pagedCases.map((c) => {
        const traceState = traceStateByCase.get(c.id);
        const effectiveTaskId = c.taskId || traceState?.taskId || null;
        const ex = effectiveTaskId ? execFallback.get(effectiveTaskId) : undefined;
        const evaluatorContext = parseExperimentCaseEvaluatorContext(c.evaluatorContextJson);
        const legacyFi = extractLegacyFiFromEvaluatorContextJson(c.evaluatorContextJson);
        const faultInjectionType =
          (typeof c.faultInjectionType === 'string' && c.faultInjectionType.trim()) ||
          legacyFi.faultInjectionType ||
          null;
        let caseValues: Record<string, unknown> | null = null;
        if (c.caseValuesJson) {
          try {
            const parsed = JSON.parse(c.caseValuesJson) as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              caseValues = parsed as Record<string, unknown>;
            }
          } catch {
            caseValues = null;
          }
        } else if (legacyFi.values) {
          caseValues = legacyFi.values;
        }
        return {
          id: c.id,
          executionId: c.executionId || traceState?.executionId || null,
          taskId: effectiveTaskId,
          input: c.input || ex?.query || '',
          actualOutput: c.actualOutput || ex?.finalResult || '',
          referenceOutput: c.referenceOutput,
          faultInjectionType,
          caseValues,
          fiTaskId: c.fiTaskId || legacyFi.fiTaskId,
          fiRunId: c.fiRunId || legacyFi.fiRunId,
          evaluatorContext: evaluatorContext.context,
          evaluatorContextError: evaluatorContext.error,
          traceStatus: traceState?.status || null,
          traceError: traceState?.error || null,
        };
      }),
      results,
      progress,
      traceProgress,
      caseTotal,
      casePage,
      casePageSize,
    });
  } catch (error) {
    console.error('[Experiment Detail Error]', error);
    return NextResponse.json({ error: 'Failed to load experiment' }, { status: 500 });
  }
}

// 停止监听：把监听实验的 watchMode 置回 false（触发查询 where watchMode=true 即不再命中，
// 该 Agent 后续新 trace 不再自动进来评；已评结果全部保留）。目前仅支持关闭。
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { username } = await resolveUser(req, body?.user);
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

    if (body?.watchMode !== false) {
      return NextResponse.json({ error: 'only supports watchMode:false (stop watching)' }, { status: 400 });
    }

    const exp = await prisma.experiment.findFirst({
      where: { id, user: username },
      select: { id: true },
    });
    if (!exp) return NextResponse.json({ error: 'experiment not found' }, { status: 404 });

    await prisma.experiment.update({
      where: { id },
      data: { watchMode: false, watchEnabledAt: null },
    });
    recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.watch.stop' });

    return NextResponse.json({ success: true, watchMode: false });
  } catch (error) {
    console.error('[Experiment PATCH Error]', error);
    return NextResponse.json({ error: 'Failed to update experiment' }, { status: 500 });
  }
}
