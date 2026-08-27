// 共享评测入口：把「一批已产生的 trace + 评估器」评测这件事交给实验引擎。
// 供 skill 概览页 / 用例分析等**客户端直连**路径调用，取代直接打 /eval/trajectory/run——
// 评测结果统一落 ExperimentEvalResult（一次调用 ↔ 一个 backing 单组实验，可复用 experimentId）。
//
// 运行 Agent、A/B 对比、流程图对齐(analyze-match) 都不在这里；这里只做「评测」。
import { after, NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { prisma } from '@/lib/storage/prisma';
import {
  ensureEvalExperiment,
  addEvalExperimentCase,
  startEvalExperimentCases,
} from '@/lib/engine/experiment/run-experiment';
import { findAgentDataset, type DatasetCase } from '@/server/agent_datasets_storage';
import {
  matchAgentDatasetCase,
  normalizeDatasetCaseMatchText,
} from '@/lib/engine/evaluation/dataset-case-match';
import {
  contextFromAvailableCatalogFields,
  EvaluatorContextValidationError,
  normalizeEvaluatorCaseContext,
  type EvaluatorCaseContext,
} from '@/lib/evaluators/evaluator-case-context';

export const dynamic = 'force-dynamic';

interface Pair {
  caseId: string;
  taskId: string;
  evaluatorContext?: unknown;
}

function asStrArr(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];
}

interface DatasetEvaluationContext {
  referenceOutput: string | null;
  evaluatorContext?: EvaluatorCaseContext;
}

/** 从 datasetIds 按 caseId 反查参考输出和 available_tools / available_skills。 */
async function buildDatasetContextMap(
  user: string,
  datasetIds: string[],
): Promise<Map<string, DatasetEvaluationContext>> {
  const map = new Map<string, DatasetEvaluationContext>();
  for (const id of datasetIds) {
    const ds = await findAgentDataset(user, id).catch(() => null);
    if (!ds) continue;
    for (const c of ds.cases) {
      if (!c.id || map.has(c.id)) continue;
      const hasTools = c.values && Object.prototype.hasOwnProperty.call(c.values, 'available_tools');
      const hasSkills = c.values && Object.prototype.hasOwnProperty.call(c.values, 'available_skills');
      let evaluatorContext: EvaluatorCaseContext | null = null;
      if (hasTools) {
        try {
          evaluatorContext = contextFromAvailableCatalogFields(
            c.values?.available_tools,
            hasSkills ? c.values?.available_skills : undefined,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : 'available_tools / available_skills 无法解析';
          throw new EvaluatorContextValidationError(`数据集 ${id} case ${c.id}: ${message}`);
        }
      }
      map.set(c.id, {
        referenceOutput: typeof c.expectedOutput === 'string' && c.expectedOutput.trim()
          ? c.expectedOutput
          : null,
        ...(evaluatorContext ? { evaluatorContext } : {}),
      });
    }
  }
  return map;
}

async function resolveTraceToolCatalog(
  user: string,
  taskId: string,
  datasetIds: string[],
): Promise<EvaluatorCaseContext | null> {
  if (!datasetIds.length || !taskId) return null;
  const exec = await prisma.execution.findFirst({
    where: { taskId, OR: [{ user }, { user: null }] },
    orderBy: { timestamp: 'desc' },
    select: { query: true },
  });
  const query = normalizeDatasetCaseMatchText(exec?.query);
  if (!query) return null;
  let matched: DatasetCase | null = null;
  let matchedDatasetId = '';
  let matchedInputLength = -1;
  for (const datasetId of datasetIds) {
    const dataset = await findAgentDataset(user, datasetId).catch(() => null);
    if (!dataset) continue;
    for (const item of dataset.cases) {
      const datasetInput = normalizeDatasetCaseMatchText(item.input);
      if (
        !datasetInput
        || !query.includes(datasetInput)
        || !item.values
        || !Object.prototype.hasOwnProperty.call(item.values, 'available_tools')
        || datasetInput.length <= matchedInputLength
      ) continue;
      matched = item;
      matchedDatasetId = datasetId;
      matchedInputLength = datasetInput.length;
    }
  }
  if (!matched?.values) return null;
  try {
    return contextFromAvailableCatalogFields(
      matched.values.available_tools,
      Object.prototype.hasOwnProperty.call(matched.values, 'available_skills')
        ? matched.values.available_skills
        : undefined,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'available_tools / available_skills 无法解析';
    throw new EvaluatorContextValidationError(`数据集 ${matchedDatasetId} case ${matched.id}: ${message}`);
  }
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
          .map((p: Record<string, unknown>) => ({
            caseId: String(p.caseId || '').trim(),
            taskId: String(p.taskId || '').trim(),
            ...(Object.prototype.hasOwnProperty.call(p, 'evaluatorContext')
              ? { evaluatorContext: p.evaluatorContext }
              : {}),
          }))
          .filter((p: Pair) => p.taskId)
      : [];
    const taskIds = asStrArr(body.taskIds);
    // createOnly（含旧 placeholderOnly 别名）：只建/复用空 backing 实验、不评测——用于「+ 新增评测任务」预建容器
    const createOnly = body.createOnly === true || body.placeholderOnly === true;
    if (!createOnly && pairs.length === 0 && taskIds.length === 0) {
      return NextResponse.json({ error: 'taskIds or pairs is required' }, { status: 400 });
    }

    const datasetContextMap = datasetIds.length
      ? await buildDatasetContextMap(username, datasetIds)
      : new Map<string, DatasetEvaluationContext>();
    const hasDefaultContext = Object.prototype.hasOwnProperty.call(body, 'evaluatorContext');
    const defaultContext = hasDefaultContext
      ? normalizeEvaluatorCaseContext(body.evaluatorContext)
      : undefined;
    const pairContexts: Array<EvaluatorCaseContext | null | undefined> = pairs.map((pair) => (
      Object.prototype.hasOwnProperty.call(pair, 'evaluatorContext')
        ? normalizeEvaluatorCaseContext(pair.evaluatorContext)
        : undefined
    ));

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
      ? pairs.map((p, index) => {
          const datasetContext = datasetContextMap.get(p.caseId);
          const evaluatorContext = pairContexts[index] !== undefined
            ? pairContexts[index]
            : hasDefaultContext
              ? defaultContext
              : datasetContext?.evaluatorContext;
          return {
            taskId: p.taskId,
            caseId: p.caseId,
            referenceOutput: datasetContext?.referenceOutput ?? null,
            evaluatorContext,
          };
        })
      : await Promise.all(taskIds.map(async (t) => ({
          taskId: t,
          caseId: undefined as string | undefined,
          referenceOutput: await resolveTraceReference(username, t, datasetIds),
          evaluatorContext: hasDefaultContext
            ? defaultContext
            : (await resolveTraceToolCatalog(username, t, datasetIds)) ?? undefined,
        })));

    const prepared = [];
    for (const t of targets) {
      const expCaseId = await addEvalExperimentCase(experimentId, {
        taskId: t.taskId, input: '', actualOutput: '', referenceOutput: t.referenceOutput,
        evaluatorContext: t.evaluatorContext,
      });
      prepared.push({ target: t, experimentCaseId: expCaseId });
    }

    const run = await startEvalExperimentCases(
      experimentId,
      prepared.map((item) => item.experimentCaseId),
      username,
    );
    if (!run) {
      return NextResponse.json({ error: 'experiment not found' }, { status: 404 });
    }
    const completion = run.completion.catch((error) => {
      console.error('[eval-traces background Error]', error);
    });
    try {
      after(() => completion);
    } catch {
      // 直接调用 route handler 的单测没有 Next request context；Promise 本身仍已启动。
    }

    const results = prepared.map(({ target: t, experimentCaseId }) => ({
        taskId: t.taskId,
        caseId: t.caseId,
        experimentCaseId,
        status: 'running',
        score: null,
        evaluations: [],
      }));

    return NextResponse.json(
      { success: true, experimentId, status: run.status, results },
      { status: 202 },
    );
  } catch (error) {
    console.error('[eval-traces POST Error]', error);
    if (error instanceof EvaluatorContextValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: 'Failed to evaluate traces via experiment' }, { status: 500 });
  }
}
