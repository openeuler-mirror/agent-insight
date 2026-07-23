/**
 * 单组实验执行引擎（M5）。
 *
 * startExperimentRun：Experiment.status → running，为每个 case × evaluator upsert
 * pending 行，异步逐行执行（并发上限 4，SimpleAsyncLimiter）；全部行终态后
 * Experiment.status = 有 done 行 ? 'done' : 'failed'。跨请求防重入：同一 experiment
 * running 时（内存 running 集合或 DB status）重复调用直接返回当前状态。
 *
 * 单行执行：
 * - 忠实版预置 LLM 评估器（任务完成度/轨迹质量）→ 复用原 opencode 评估器；
 * - 结果评测预置评估器 → 复用可靠性页 canonical 结果评估能力；
 * - 自建 LLM 评估器 → buildJudgePrompt → callJudgeLlm（薄封装，测试可注入 fake）
 *   → parseJudgeText → normalizeEvaluatorOutput。
 *
 * 失败处理：异常写 status='failed' + errorMessage + attempts；JudgeOutputParseError /
 * 超时类可重试（退避见 experimentEngineConfig.retryDelaysMs，默认 2s/8s）；
 * 单行超时 5 分钟。
 */
import { prisma } from '@/lib/storage/prisma';
import {
  buildJudgePrompt,
  parseJudgeText,
  JudgeOutputParseError,
  type JudgeCaseContext,
} from '@/lib/evaluators/judge-assembly';
import type { EvaluatorOutput } from '@/lib/evaluators/eval-output';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { readUserCustomEvaluators } from '@/server/user_evaluators_storage';
import { createSimpleAsyncLimiter } from '@/lib/engine/evaluation/eval-run-guards';
import { callJudgeLlm } from './judge-llm';
import {
  isFaithfulPresetId,
  runFaithfulPreset,
  type FaithfulPresetContext,
} from './faithful-preset-evaluators';
import { isResultPresetId, runResultPreset } from './result-preset-evaluators';

/** 引擎参数（测试可改小重试退避/超时；生产用默认值）。 */
export const experimentEngineConfig = {
  /** 可重试失败的退避序列；长度 = 最大重试次数（默认 2 次重试 → 最多 3 次尝试） */
  retryDelaysMs: [2_000, 8_000],
  /** 单行执行超时 */
  rowTimeoutMs: 5 * 60_000,
  /** 行级并发上限 */
  concurrency: 4,
};

// ── 评估器卡解析 ────────────────────────────────────────────────────────────
// preset-agent-task-completion / preset-agent-trace-quality 由忠实版适配器
// （faithful-preset-evaluators.ts）复用原 opencode 评估器处理，不走本函数。
// 本函数只解析：其它预置卡 + 自建 LLM 评估器。

async function resolveEvaluatorCard(user: string, evaluatorId: string): Promise<EvaluatorCard | null> {
  const preset = presetEvaluators.find((p) => p.id === evaluatorId);
  if (preset) return preset;
  const items = (await readUserCustomEvaluators(user)) as EvaluatorCard[];
  return items.find((it) => it && typeof it === 'object' && it.id === evaluatorId) ?? null;
}

// ── case 运行时上下文（Execution + 可选 interactions 工具序列）─────────────

interface CaseRuntime {
  judgeCtx: JudgeCaseContext;
  /** 忠实版预置评估器（复用原 opencode 评估器）所需的原始上下文。 */
  faithfulCtx: FaithfulPresetContext;
}

function parseFailureSummaries(failures: string | null | undefined): string[] {
  if (!failures) return [];
  try {
    const arr = JSON.parse(failures);
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 20).map((f) => {
      if (typeof f === 'string') return f.slice(0, 200);
      if (f && typeof f === 'object') {
        const r = f as Record<string, unknown>;
        const name = r.tool ?? r.name ?? r.step ?? r.type;
        if (typeof name === 'string' && name) return name;
      }
      return JSON.stringify(f).slice(0, 200);
    });
  } catch {
    return [];
  }
}

/** 从 Session.interactions 提取按执行顺序的工具名序列（tool_calls 优先，parts 兜底）。 */
export function extractToolCallNames(interactions: unknown[]): string[] {
  const names: string[] = [];
  for (const it of interactions) {
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const calls = Array.isArray(r.tool_calls) ? r.tool_calls : [];
    let pushed = false;
    for (const tc of calls) {
      if (tc && typeof tc === 'object' && typeof (tc as any).name === 'string' && (tc as any).name) {
        names.push((tc as any).name);
        pushed = true;
      }
    }
    if (!pushed && Array.isArray(r.parts)) {
      for (const p of r.parts) {
        if (p && typeof p === 'object' && (p as any).type === 'tool' && typeof (p as any).tool === 'string') {
          names.push((p as any).tool);
        }
      }
    }
  }
  return names;
}

async function loadCaseRuntime(caseRow: {
  executionId: string | null;
  taskId: string | null;
  input: string;
  actualOutput: string;
  referenceOutput: string | null;
}, user: string): Promise<CaseRuntime> {
  const execution = caseRow.executionId
    ? await prisma.execution.findUnique({ where: { id: caseRow.executionId } })
    : null;

  // interactions 工具序列（Session 按 taskId 关联）；拿不到 → undefined，冗余检测自然降级无分
  let toolCallNames: string[] | undefined;
  let rawInteractions: unknown[] = []; // 忠实版轨迹评估器需要原始 interactions
  const taskId = caseRow.taskId || execution?.taskId || null;
  if (taskId) {
    try {
      const session = await prisma.session.findUnique({
        where: { taskId },
        select: { interactions: true },
      });
      if (session?.interactions) {
        const parsed = JSON.parse(session.interactions);
        if (Array.isArray(parsed)) {
          rawInteractions = parsed;
          toolCallNames = extractToolCallNames(parsed);
        }
      }
    } catch {
      toolCallNames = undefined;
    }
  }

  // judge 轨迹文本：工具序列 + 失败摘要的紧凑序列化（引擎侧提取）
  const failureSummaries = parseFailureSummaries(execution?.failures);
  let trajectory: string | null = null;
  if (toolCallNames && toolCallNames.length) {
    const lines = toolCallNames.slice(0, 200).map((n, i) => `${i + 1}. ${n}`);
    const fails = failureSummaries.length
      ? `\n失败项：${failureSummaries.join('、')}`
      : '';
    trajectory = `工具调用序列（共 ${toolCallNames.length} 次）：\n${lines.join('\n')}${fails}`;
  }

  const judgeCtx: JudgeCaseContext = {
    input: caseRow.input,
    output: caseRow.actualOutput,
    referenceOutput: caseRow.referenceOutput,
    trajectory,
  };

  const faithfulCtx: FaithfulPresetContext = {
    caseInput: caseRow.input,
    actualOutput: caseRow.actualOutput,
    referenceOutput: caseRow.referenceOutput,
    traceSummaryText: trajectory,
    interactions: rawInteractions,
    taskId,
    executionId: caseRow.executionId,
    user,
    execution: execution ? {
      id: execution.id, taskId: execution.taskId, query: execution.query, finalResult: execution.finalResult,
      skill: execution.skill, skillVersion: execution.skillVersion,
      invokedSkills: execution.invokedSkills, skills: execution.skills,
    } : null,
  };

  return { judgeCtx, faithfulCtx };
}

// ── 单行执行（含重试/超时）────────────────────────────────────────────────

function isRetryableRowFailure(error: unknown): boolean {
  if (error instanceof JudgeOutputParseError) return true;
  const msg = error instanceof Error ? error.message : String(error || '');
  return /超时|timeout|timed out/i.test(msg);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`单行评估超时（${ms}ms）`)), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<T>;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

async function evaluateOnce(
  user: string,
  evaluatorId: string,
  runtime: CaseRuntime,
): Promise<EvaluatorOutput> {
  // 忠实版预置 LLM 评估器：复用原 opencode 评估器逻辑（口径与评测执行一致 + 归因字段）
  if (isFaithfulPresetId(evaluatorId)) {
    return runFaithfulPreset(evaluatorId, user, runtime.faithfulCtx);
  }
  // 结果评测预置评估器：复用可靠性页同一 canonical 结果评估能力
  if (isResultPresetId(evaluatorId)) {
    return runResultPreset(evaluatorId, user, runtime.faithfulCtx);
  }
  const card = await resolveEvaluatorCard(user, evaluatorId);
  if (!card) throw new Error(`未找到评估器 ${evaluatorId}（可能已被删除）`);
  if (card.evaluatorType !== 'LLM' || !card.llmConfig?.systemPrompt) {
    throw new Error(`评估器 ${evaluatorId} 缺少可执行的 LLM 配置`);
  }
  const prompt = buildJudgePrompt(card, runtime.judgeCtx);
  const text = await callJudgeLlm(user, {
    system: prompt.system,
    user: prompt.user,
    sessionTitle: `exp-judge-${evaluatorId}`,
  });
  // parseJudgeText 内部已过 normalizeEvaluatorOutput 宽容归一化
  return parseJudgeText(text, card.pointsDef);
}

/**
 * 执行一行 ExperimentEvalResult（含重试与单行超时），写回终态。
 * 返回终态 status（'done' | 'failed'）。
 */
export async function executeResultRow(user: string, resultId: string): Promise<'done' | 'failed'> {
  const row = await prisma.experimentEvalResult.findUnique({
    where: { id: resultId },
    include: { case: true },
  });
  if (!row) throw new Error(`ExperimentEvalResult ${resultId} 不存在`);

  await prisma.experimentEvalResult.update({
    where: { id: resultId },
    data: { status: 'running', errorMessage: null },
  });

  const startedAt = Date.now();
  const maxAttempts = experimentEngineConfig.retryDelaysMs.length + 1;
  let localAttempts = 0;
  let lastError: unknown = null;

  const runtime = await loadCaseRuntime(row.case, user);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    localAttempts = attempt;
    try {
      const out = await withTimeout(
        evaluateOnce(user, row.evaluatorId, runtime),
        experimentEngineConfig.rowTimeoutMs,
      );
      await prisma.experimentEvalResult.update({
        where: { id: resultId },
        data: {
          status: 'done',
          score: out.score ?? null,
          pointsJson: out.points ? JSON.stringify(out.points) : null,
          evidenceJson: out.evidence ? JSON.stringify(out.evidence) : null,
          errorMessage: null,
          attempts: row.attempts + localAttempts,
          durationMs: Date.now() - startedAt,
        },
      });
      return 'done';
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts && isRetryableRowFailure(e)) {
        await sleep(experimentEngineConfig.retryDelaysMs[attempt - 1] ?? 0);
        continue;
      }
      break;
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError || '未知错误');
  await prisma.experimentEvalResult.update({
    where: { id: resultId },
    data: {
      status: 'failed',
      errorMessage: message.slice(0, 2000),
      attempts: row.attempts + localAttempts,
      durationMs: Date.now() - startedAt,
    },
  });
  return 'failed';
}

// ── 实验级执行 ──────────────────────────────────────────────────────────────

// 跨请求防重入：running 集合挂 globalThis（Next dev 下模块可能被多实例加载）
const RUNNING_SET_KEY = Symbol.for('agent-insight.experiment.running-set');
function getRunningSet(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string>>;
  if (!g[RUNNING_SET_KEY]) g[RUNNING_SET_KEY] = new Set<string>();
  return g[RUNNING_SET_KEY];
}

async function settleExperimentStatus(experimentId: string): Promise<void> {
  const rows = await prisma.experimentEvalResult.findMany({
    where: { experimentId },
    select: { status: true },
  });
  const anyPending = rows.some((r: { status: string }) => r.status === 'pending' || r.status === 'running');
  if (anyPending) return; // 尚未全部终态（单项 retry 场景下可能仍有 running）
  const anyDone = rows.some((r: { status: string }) => r.status === 'done');
  await prisma.experiment.update({
    where: { id: experimentId },
    data: { status: anyDone ? 'done' : 'failed' },
  });
}

export interface StartExperimentRunResult {
  status: string;
  alreadyRunning?: boolean;
  /** 全部行执行完并写回实验终态的 promise（API 路由 fire-and-forget；测试 await 它） */
  completion?: Promise<void>;
}

/**
 * 触发实验执行。同 experiment 已在 running（内存或 DB 状态）时直接返回当前状态，不重复起跑。
 */
export async function startExperimentRun(
  experimentId: string,
  user: string,
): Promise<StartExperimentRunResult | null> {
  const running = getRunningSet();
  if (running.has(experimentId)) return { status: 'running', alreadyRunning: true };

  const experiment = await prisma.experiment.findFirst({
    where: { id: experimentId, user },
    include: { cases: { orderBy: { createdAt: 'asc' } } },
  });
  if (!experiment) return null;
  if (experiment.status === 'running') return { status: 'running', alreadyRunning: true };

  let evaluatorIds: string[] = [];
  try {
    const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
    if (Array.isArray(parsed)) evaluatorIds = parsed.map(String).filter(Boolean);
  } catch { /* 忽略脏数据 */ }
  if (!evaluatorIds.length || !experiment.cases.length) {
    return { status: experiment.status };
  }

  running.add(experimentId);
  try {
    await prisma.experiment.update({
      where: { id: experimentId },
      data: { status: 'running' },
    });

    // 为每个 case × evaluator upsert pending 行（重跑时重置旧结果）
    const resultIds: string[] = [];
    for (const c of experiment.cases) {
      for (const evaluatorId of evaluatorIds) {
        const row = await prisma.experimentEvalResult.upsert({
          where: { caseId_evaluatorId: { caseId: c.id, evaluatorId } },
          create: { experimentId, caseId: c.id, evaluatorId, status: 'pending' },
          update: {
            status: 'pending',
            score: null,
            pointsJson: null,
            evidenceJson: null,
            errorMessage: null,
            durationMs: null,
          },
          select: { id: true },
        });
        resultIds.push(row.id);
      }
    }

    const completion = runAllRows(experimentId, user, resultIds).finally(() => {
      running.delete(experimentId);
    });
    return { status: 'running', completion };
  } catch (e) {
    running.delete(experimentId);
    throw e;
  }
}

async function runAllRows(experimentId: string, user: string, resultIds: string[]): Promise<void> {
  const limiter = createSimpleAsyncLimiter(experimentEngineConfig.concurrency);
  await Promise.all(
    resultIds.map(async (resultId) => {
      await limiter.acquire();
      try {
        await executeResultRow(user, resultId);
      } catch (e) {
        // executeResultRow 内部已写 failed；这里兜底行本身不存在等意外
        console.error(`[experiment-engine] row ${resultId} failed:`, (e as Error)?.message);
        try {
          await prisma.experimentEvalResult.update({
            where: { id: resultId },
            data: {
              status: 'failed',
              errorMessage: ((e as Error)?.message || '未知错误').slice(0, 2000),
            },
          });
        } catch { /* 行不存在时放弃 */ }
      } finally {
        limiter.release();
      }
    }),
  );
  await settleExperimentStatus(experimentId);
}

/**
 * 单项重评：重置该行 pending 并单行执行，随后按需回写实验终态。
 * 返回终态 status；行不属于该用户/实验时返回 null。
 */
export async function retryResultRow(
  experimentId: string,
  resultId: string,
  user: string,
): Promise<'done' | 'failed' | null> {
  const row = await prisma.experimentEvalResult.findFirst({
    where: { id: resultId, experimentId, case: { experiment: { user } } },
    select: { id: true },
  });
  if (!row) return null;

  await prisma.experimentEvalResult.update({
    where: { id: resultId },
    data: {
      status: 'pending',
      score: null,
      pointsJson: null,
      evidenceJson: null,
      errorMessage: null,
      durationMs: null,
    },
  });
  const status = await executeResultRow(user, resultId);
  await settleExperimentStatus(experimentId);
  return status;
}
