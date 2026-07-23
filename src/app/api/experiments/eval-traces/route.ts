// 共享评测入口：把「一批已产生的 trace + 评估器」评测这件事交给实验引擎。
// 供 skill 概览页 / 用例分析等**客户端直连**路径调用，取代直接打 /eval/trajectory/run——
// 评测结果统一落 ExperimentEvalResult（一次调用 ↔ 一个 backing 单组实验，可复用 experimentId）。
//
// 运行 Agent、A/B 对比、流程图对齐(analyze-match) 都不在这里；这里只做「评测」。
import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import {
  ensureEvalExperiment,
  addEvalExperimentCase,
  evaluateEvalExperimentCase,
} from '@/lib/engine/experiment/run-experiment';
import { findAgentDataset } from '@/server/agent_datasets_storage';

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
    if (pairs.length === 0 && taskIds.length === 0) {
      return NextResponse.json({ error: 'taskIds or pairs is required' }, { status: 400 });
    }

    const expectedMap = datasetIds.length ? await buildExpectedMap(username, datasetIds) : new Map<string, string>();

    const experimentId = await ensureEvalExperiment({
      user: username,
      name: String(body.name || '用例分析') + ` · ${new URL(req.url).searchParams.get('t') || ''}`.trimEnd(),
      agentName: typeof body.agentName === 'string' ? body.agentName : '',
      evaluatorIds: evaluators,
      existingId: typeof body.experimentId === 'string' ? body.experimentId : null,
    });

    // 目标列表：pairs（带 caseId → 参考答案）优先；否则 taskIds（trace 模式，引擎按 taskId 兜底解析）
    const targets = pairs.length
      ? pairs.map((p) => ({ taskId: p.taskId, caseId: p.caseId, referenceOutput: expectedMap.get(p.caseId) ?? null }))
      : taskIds.map((t) => ({ taskId: t, caseId: undefined as string | undefined, referenceOutput: null as string | null }));

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
