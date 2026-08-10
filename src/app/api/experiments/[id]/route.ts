// 实验详情：实验元信息 + 服务端聚合（整体均分 overall / 评估器分解 breakdown /
// 进度 progress，均由全量结果算出）+ 服务端分页的 case 列表（cases 及其 results，
// 仅当前页）。case 多（尤其监听实验会持续累积）时不再一次拉全量。
import { NextResponse } from 'next/server';
import type { ExperimentCase, ExperimentEvalResult } from '@prisma/client';
import { parseStoredEvaluatorCaseContext } from '@/lib/evaluators/evaluator-case-context';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { overallAverage, evaluatorBreakdown } from '@/lib/engine/experiment/detail-agg';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

export const dynamic = 'force-dynamic';

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
    const progress = {
      total: allResults.length,
      done: allResults.filter((r: { status: string }) => r.status === 'done').length,
      failed: allResults.filter((r: { status: string }) => r.status === 'failed').length,
      pending: allResults.filter((r: { status: string }) => r.status === 'pending' || r.status === 'running').length,
    };
    const overall = overallAverage(allResults);
    const breakdown = evaluatorBreakdown(allResults);

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

    // input/actualOutput 兜底：trace/监听模式建的 case 这两字段存空，从对应 Execution
    // 的 query/finalResult 兜底（与评估时 loadCaseRuntime 口径一致），否则详情页显示为 "-"。
    const needExecTaskIds = Array.from(new Set(
      pagedCases
        .filter((c) => c.taskId && (!c.input || !c.actualOutput))
        .map((c) => c.taskId as string),
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

    const parseJson = (s: string | null): unknown => {
      if (!s) return null;
      try { return JSON.parse(s); } catch { return null; }
    };
    const results = pagedCases.flatMap((c) =>
      c.results.map((r) => ({
        id: r.id,
        caseId: r.caseId,
        evaluatorId: r.evaluatorId,
        status: r.status,
        verdict: r.verdict,
        summary: r.summary,
        score: r.score,
        points: parseJson(r.pointsJson),
        evidence: parseJson(r.evidenceJson),
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
        const ex = c.taskId ? execFallback.get(c.taskId) : undefined;
        const evaluatorContext = parseStoredEvaluatorCaseContext(c.evaluatorContextJson);
        return {
          id: c.id,
          executionId: c.executionId,
          taskId: c.taskId,
          input: c.input || ex?.query || '',
          actualOutput: c.actualOutput || ex?.finalResult || '',
          referenceOutput: c.referenceOutput,
          evaluatorContext: evaluatorContext.context,
          evaluatorContextError: evaluatorContext.error,
        };
      }),
      results,
      progress,
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
