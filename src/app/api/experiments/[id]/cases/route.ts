// 往已建实验追加 case（建实验向导之外的第二个入口）。
//
// 复用监听模式同一套积木：addEvalExperimentCase（按 taskId 幂等，重复圈选同一条 trace
// 只会复用已有 case 并回填参考答案）+ evaluateEvalExperimentCase（按实验既定的
// evaluatorIds 评这一条）。评测在后台 fire-and-forget 跑，接口只回"收了几条"。
//
// 注意：新 case 走的是**实验创建时定下的评估器**，不重新做 ④ 步门控。若实验里含依赖
// 参考数据的评估器而新 case 没标注参考答案，那一行会落到评估器自己的"未标注→不记分"
// 兜底（见 result-preset-evaluators）。入口 UI 负责把这个提示前置给用户。
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import { resolveUser } from '@/lib/auth/auth';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { addEvalExperimentCase, evaluateEvalExperimentCase } from '@/lib/engine/experiment/run-experiment';

export const dynamic = 'force-dynamic';

/** 单次追加上限：与向导跨页全选的 SELECT_ALL_CAP 同量级，避免一次灌爆评测队列。 */
const MAX_CASES_PER_CALL = 200;

interface CaseInput {
  executionId?: string;
  taskId?: string;
  input?: string;
  actualOutput?: string;
  referenceOutput?: string | null;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { username } = await resolveUser(req, body?.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }

    const cases: CaseInput[] = Array.isArray(body?.cases) ? body.cases : [];
    if (!cases.length) {
      return NextResponse.json({ error: 'at least one case is required' }, { status: 400 });
    }
    if (cases.length > MAX_CASES_PER_CALL) {
      return NextResponse.json(
        { error: `一次最多追加 ${MAX_CASES_PER_CALL} 条 case` },
        { status: 400 },
      );
    }
    // 默认追加即评（用户在详情页点"新增"就是想看结果）；传 false 只入库不评。
    const autoRun = body?.autoRun !== false;

    const experiment = await prisma.experiment.findFirst({
      where: { id, user: username },
      select: { id: true, evaluatorIdsJson: true },
    });
    if (!experiment) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }
    let evaluatorIds: string[] = [];
    try {
      const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
      if (Array.isArray(parsed)) evaluatorIds = parsed.map(String).filter(Boolean);
    } catch { /* 忽略脏数据 */ }
    if (autoRun && !evaluatorIds.length) {
      return NextResponse.json({ error: '该实验未配置评估器，无法评测新增 case' }, { status: 409 });
    }

    // 已在本实验里的 trace 会被 addEvalExperimentCase 按 taskId 复用而非新建，
    // 先记下来好如实回报"新增 N 条、复用 M 条"，别把复用也报成新增。
    const incomingTaskIds = cases.map((c) => (c.taskId ? String(c.taskId) : '')).filter(Boolean);
    const existingTaskIds = new Set(
      incomingTaskIds.length
        ? (await prisma.experimentCase.findMany({
            where: { experimentId: id, taskId: { in: incomingTaskIds } },
            select: { taskId: true },
          })).map((r: { taskId: string | null }) => r.taskId ?? '')
        : [],
    );

    const caseIds: string[] = [];
    for (const c of cases) {
      const caseId = await addEvalExperimentCase(id, {
        executionId: c.executionId ? String(c.executionId) : null,
        taskId: c.taskId ? String(c.taskId) : null,
        input: String(c.input ?? ''),
        actualOutput: String(c.actualOutput ?? ''),
        referenceOutput:
          c.referenceOutput != null && String(c.referenceOutput).trim() !== ''
            ? String(c.referenceOutput)
            : null,
      });
      caseIds.push(caseId);
    }
    const reused = incomingTaskIds.filter((t) => existingTaskIds.has(t)).length;

    if (autoRun) {
      // 先把全部新行建成 pending 再开跑：evaluateEvalExperimentCase 每评完一条都会调
      // settleExperimentStatus，若后续 case 的行还没建出来，它会看到"无待执行行"从而
      // 提前把实验落成 done，进度条在 done/running 之间来回跳。
      await prisma.$transaction(
        caseIds.flatMap((caseId) =>
          evaluatorIds.map((evaluatorId) =>
            prisma.experimentEvalResult.upsert({
              where: { caseId_evaluatorId: { caseId, evaluatorId } },
              create: { experimentId: id, caseId, evaluatorId, status: 'pending' },
              update: { status: 'pending' },
              select: { id: true },
            }),
          ),
        ),
      );
      await prisma.experiment.update({ where: { id }, data: { status: 'running' } });

      // 逐条串行评（evaluateEvalExperimentCase 内部本就是同步跑完一条），后台推进；
      // 单条失败不影响后续——executeResultRow 已把失败写成该行的终态。
      void (async () => {
        for (const caseId of caseIds) {
          try {
            await evaluateEvalExperimentCase(id, caseId, username);
          } catch (e) {
            console.warn(`[experiment-cases] eval failed exp=${id} case=${caseId}:`, (e as Error)?.message);
          }
        }
      })();
    }

    recordUsageEvent({ user: username, featureKey: 'experiments', eventKey: 'experiment.case.create' });

    return NextResponse.json({
      added: caseIds.length - reused,
      reused,
      caseIds,
      evaluating: autoRun,
    });
  } catch (error) {
    console.error('[Experiment Cases POST Error]', error);
    return NextResponse.json({ error: 'Failed to add cases' }, { status: 500 });
  }
}
