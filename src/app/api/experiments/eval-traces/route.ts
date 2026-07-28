// 共享评测入口：把「一批已产生的 trace + 评估器」评测这件事交给实验引擎。
// 供 skill 概览页 / 用例分析等**客户端直连**路径调用，取代直接打 /eval/trajectory/run——
// 评测结果统一落 ExperimentEvalResult（一次调用 ↔ 一个 backing 单组实验，可复用 experimentId）。
//
// 运行 Agent、A/B 对比、流程图对齐(analyze-match) 都不在这里；这里只做「评测」。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { prisma } from '@/lib/storage/prisma';
import {
  ensureEvalExperiment,
  addEvalExperimentCase,
  evaluateEvalExperimentCase,
} from '@/lib/engine/experiment/run-experiment';
import { findAgentDataset } from '@/server/agent_datasets_storage';
import { matchAgentDatasetCase } from '@/lib/engine/evaluation/dataset-case-match';

export const dynamic = 'force-dynamic';

interface Pair { caseId: string; taskId: string }

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];
}

/** 从 datasetIds 反查每个 caseId 的预期输出（评测参考答案），缺失为 null。 */
async function buildExpectedMap(user: string, datasetIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of datasetIds) {
    const ds = await findAgentDataset(user, id).catch(() => null);
    if (!ds) continue;
    for (const c of ds.cases) {
      if (c.id && typeof c.expectedOutput === 'string' && !map.has(c.id)) map.set(c.id, c.expectedOutput);
    }
  }
  return map;
}

/**
 * trace 模式（选已有 Trace，无 pairs）按输入把 trace 匹配到数据集 case，取其 expectedOutput
 * 作参考答案——否则 accuracy/任务完成度等依赖参考的评估器拿不到标准答案会失败/判"未标注"。
 * 与前端「系统会将 trace 输入与数据集 case 自动匹配」的承诺对齐。取不到返回 null。
 */
async function resolveTraceReference(user: string, taskId: string, datasetIds: string[]): Promise<string | null> {
  if (!datasetIds.length || !taskId) return null;
  const exec = await prisma.execution.findFirst({
    where: { taskId, OR: [{ user }, { user: null }] },
    orderBy: { timestamp: 'desc' },
    select: { query: true },
  });
  const query = String(exec?.query || '').trim();
  if (!query) return null;
  try {
    const m = await matchAgentDatasetCase({
      user, traceQuery: query, allowedDatasetIds: datasetIds, requireExpectedOutput: true,
    });
    const ref = m.match?.caseEntry.expectedOutput;
    return ref && String(ref).trim() ? String(ref) : null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { username } = await resolveUser(req, body.user);
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });

    const evaluators = asStrArr(body.evaluators);
    if (evaluators.length === 0) return NextResponse.json({ error: 'evaluators is required' }, { status: 400 });

    const datasetIds = asStrArr(body.datasetIds);
    const pairs: Pair[] = Array.isArray(body.pairs)
      ? body.pairs
          .map((p: unknown) => (p && typeof p === 'object' ? p as Record<string, unknown> : {}))
          .map((p: Record<string, unknown>) => ({ caseId: String(p.caseId || '').trim(), taskId: String(p.taskId || '').trim() }))
          .filter((p: Pair) => p.taskId)
      : [];
    const taskIds = asStrArr(body.taskIds);
    // createOnly（含旧 placeholderOnly 别名）：只建/复用空 backing 实验、不评测——用于「+ 新增评测任务」预建容器
    const createOnly = body.createOnly === true || body.placeholderOnly === true;
    if (!createOnly && pairs.length === 0 && taskIds.length === 0) {
      return NextResponse.json({ error: 'taskIds or pairs is required' }, { status: 400 });
    }

    const expectedMap = datasetIds.length ? await buildExpectedMap(username, datasetIds) : new Map<string, string>();

    const skillName = typeof body.skillName === 'string' ? body.skillName : '';
    const skillVersion = typeof body.skillVersion === 'number' ? body.skillVersion
      : (body.skillVersion != null && !Number.isNaN(Number(body.skillVersion)) ? Number(body.skillVersion) : null);
    const experimentId = await ensureEvalExperiment({
      user: username,
      name: String(body.name || '用例分析'),
      agentName: typeof body.agentName === 'string' ? body.agentName : skillName,
      evaluatorIds: evaluators,
      existingId: typeof body.experimentId === 'string' ? body.experimentId : null,
      scope: typeof body.scope === 'string' && body.scope ? body.scope : 'skill-case-analysis',
      skillName,
      skillVersion,
    });

    if (createOnly) {
      return NextResponse.json({ success: true, experimentId, results: [] });
    }

    // 目标列表：pairs（带 caseId → 参考答案）优先；否则 taskIds（trace 模式，按输入匹配数据集取参考答案）
    const targets = pairs.length
      ? pairs.map((p) => ({ taskId: p.taskId, caseId: p.caseId, referenceOutput: expectedMap.get(p.caseId) ?? null }))
      : await Promise.all(taskIds.map(async (t) => ({
          taskId: t,
          caseId: undefined as string | undefined,
          referenceOutput: await resolveTraceReference(username, t, datasetIds),
        })));

    const results = [];
    for (const t of targets) {
      const expCaseId = await addEvalExperimentCase(experimentId, {
        taskId: t.taskId, input: '', actualOutput: '', referenceOutput: t.referenceOutput,
      });
      const rows = await evaluateEvalExperimentCase(experimentId, expCaseId, username);
      const done = rows.filter((r) => r.status === 'done' && typeof r.score === 'number');
      const score = done.length ? Math.round(done.reduce((s, r) => s + (r.score as number), 0) / done.length) : null;
      results.push({
        taskId: t.taskId,
        caseId: t.caseId,
        experimentCaseId: expCaseId,
        status: rows.length && done.length === 0 ? 'failed' : 'done',
        score,
        evaluations: rows.map((r) => ({ evaluatorId: r.evaluatorId, status: r.status, score: r.score, errorMessage: r.errorMessage })),
      });
    }

    return NextResponse.json({ success: true, experimentId, results });
  } catch (error) {
    console.error('[eval-traces POST Error]', error);
    return NextResponse.json({ error: 'Failed to evaluate traces via experiment' }, { status: 500 });
  }
}
