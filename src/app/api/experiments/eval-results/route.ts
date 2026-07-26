// 实验版「评测结果明细」读接口——对齐旧 /api/eval/trajectory/results 的消费形状，
// 供 skill 概览页 / _batch / useBatchEvalResults 显示读取从 ExperimentEvalResult 取数。
//
// 一个 ExperimentCase(=一条 trace) 聚合成一行 result：
//   trajectoryScore/resultEvaluationScore 回 0-1（前端各处 ×100，与旧口径一致，避免 100× 放大）。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';

export const dynamic = 'force-dynamic';

const TRACE_EVALUATOR_ID = 'preset-agent-trace-quality';
const TASK_COMPLETION_EVALUATOR_ID = 'preset-agent-task-completion';

interface ResultRow {
  id: string;
  status: string;
  score: number | null;
  errorMessage: string | null;
  evaluatorId: string;
}

/** 一个 case 的多评估器行 → 对齐旧 trajectory/results 的单行形状。 */
function buildCaseResult(caseRow: { id: string; taskId: string | null; executionId: string | null; createdAt: Date }, rows: ResultRow[], updatedAt: Date) {
  const traj = rows.find((r) => r.evaluatorId === TRACE_EVALUATOR_ID);
  const result = rows.find((r) => r.evaluatorId === TASK_COMPLETION_EVALUATOR_ID);
  const anyRunning = rows.some((r) => r.status === 'pending' || r.status === 'running');
  const anyFailed = rows.some((r) => r.status === 'failed');
  const allDone = rows.length > 0 && rows.every((r) => r.status === 'done');
  const status = anyRunning ? 'running' : allDone ? 'done' : anyFailed ? 'failed' : (rows[0]?.status ?? 'pending');
  const to01 = (s: number | null | undefined) => (typeof s === 'number' ? Math.round((s / 100) * 1000) / 1000 : null);
  const firstErr = rows.find((r) => r.errorMessage)?.errorMessage ?? null;
  return {
    id: caseRow.id,
    evaluatorRunId: undefined as string | undefined, // 由调用处补 experimentId
    datasetId: undefined,
    caseId: caseRow.id,
    executionId: caseRow.executionId ?? undefined,
    taskId: caseRow.taskId ?? undefined,
    status,
    errorMessage: firstErr,
    trajectoryScore: to01(traj?.score),                 // 0-1（前端 ×100）
    resultEvaluationScore: to01(result?.score),         // 0-1（前端 ×100）
    rawAnalysis: {
      resultEvaluation: result ? { score: to01(result.score) } : undefined,
      resultEvaluationError: result?.status === 'failed' ? (result.errorMessage ?? undefined) : undefined,
      trajectoryError: traj?.status === 'failed' ? (traj.errorMessage ?? undefined) : undefined,
    },
    createdAt: caseRow.createdAt,
    updatedAt,
  };
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const { username } = await resolveUser(req, url.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

    const runId = url.searchParams.get('runId') || '';       // = experimentId
    const taskId = url.searchParams.get('taskId') || '';
    const limit = Math.min(Number(url.searchParams.get('limit')) || 500, 500);
    if (!runId && !taskId) return NextResponse.json({ error: 'runId or taskId is required' }, { status: 400 });

    // 圈定 case：按 experimentId(runId) 或按 taskId（跨本人实验取最近）
    const caseWhere: Record<string, unknown> = {};
    if (runId) caseWhere.experimentId = runId;
    if (taskId) caseWhere.taskId = taskId;
    // 权限：case 必须属于本人的实验
    const cases = await prisma.experimentCase.findMany({
      where: { ...caseWhere, experiment: { user: username } },
      orderBy: { createdAt: 'desc' },
      take: taskId && !runId ? 1 : limit,
      select: {
        id: true, taskId: true, executionId: true, createdAt: true, experimentId: true,
        results: { select: { evaluatorId: true, status: true, score: true, errorMessage: true, updatedAt: true } },
      },
    });

    type CaseRes = { evaluatorId: string; status: string; score: number | null; errorMessage: string | null; updatedAt: Date };
    type CaseWithRes = { id: string; taskId: string | null; executionId: string | null; createdAt: Date; experimentId: string; results: CaseRes[] };
    const results = cases.map((c: CaseWithRes) => {
      const rows: ResultRow[] = c.results.map((r: CaseRes) => ({ id: c.id, evaluatorId: r.evaluatorId, status: r.status, score: r.score, errorMessage: r.errorMessage }));
      const updatedAt = c.results.reduce((mx: Date, r: CaseRes) => (r.updatedAt > mx ? r.updatedAt : mx), c.createdAt);
      const row = buildCaseResult(c, rows, updatedAt);
      row.evaluatorRunId = c.experimentId;
      return row;
    });

    return NextResponse.json({ results });
  } catch (error) {
    console.error('[experiments/eval-results GET Error]', error);
    return NextResponse.json({ error: 'Failed to load eval results' }, { status: 500 });
  }
}
