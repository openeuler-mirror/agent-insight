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
 * - 回答深度性评估器 → 使用 case 输入与实际回答做离散 Judge，再由代码加权；
 * - Tool/Skill 利用率、选择合理性评估器 → 使用显式能力目录与原始 interactions，
 *   分别执行确定性统计、离散 Judge 和加权；Agent/子 Agent 不计入能力调用；
 * - 自建 LLM 评估器 → buildJudgePrompt → callJudgeLlm（薄封装，测试可注入 fake）
 *   → parseJudgeText → normalizeEvaluatorOutput。
 *
 * 专项评估器上下文数据流：ExperimentCase.evaluatorContextJson 在 loadCaseRuntime 中解析为
 * evaluatorContext，并与 caseInput、actualOutput、interactions 一起传给对应评估器。目录缺失或
 * 存量 JSON 非法时，工具类评估器返回不计分结果；回答深度性不依赖该目录。
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
import {
  normalizeEvaluatorCaseContext,
  parseStoredEvaluatorCaseContext,
  type EvaluatorCaseContext,
} from '@/lib/evaluators/evaluator-case-context';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { readUserCustomEvaluators } from '@/server/user_evaluators_storage';
import {
  createSimpleAsyncLimiter,
  type SimpleAsyncLimiter,
} from '@/lib/engine/evaluation/eval-run-guards';
import { callJudgeLlm } from './judge-llm';
import {
  isFaithfulPresetId,
  runFaithfulPreset,
  type FaithfulPresetContext,
} from './faithful-preset-evaluators';
import { isResultPresetId, runResultPreset } from './result-preset-evaluators';
import { isContentPresetId, runContentPreset } from './content-preset-evaluators';
import { isCreativityPresetId, runCreativityPreset } from './creativity-preset-evaluators';
import { isSafetyPresetId, runSafetyPreset } from './safety-preset-evaluators';
import { isDepthPresetId, runDepthPreset } from './depth-preset-evaluators';
import {
  isAgentToolPresetId,
  runAgentToolPreset,
} from './agent-tool-preset-evaluators';

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
  /** 忠实版预置评估器（复用原 opencode 评估器）所需的原始上下文；
   *  安全与创意评估器也共用此类型（见 §4.3 实现签名）。 */
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
      if (!tc || typeof tc !== 'object') continue;
      const call = tc as Record<string, unknown>;
      if (typeof call.name === 'string' && call.name) {
        names.push(call.name);
        pushed = true;
      }
    }
    if (!pushed && Array.isArray(r.parts)) {
      for (const p of r.parts) {
        if (!p || typeof p !== 'object') continue;
        const part = p as Record<string, unknown>;
        if (part.type === 'tool' && typeof part.tool === 'string') {
          names.push(part.tool);
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
  evaluatorContextJson: string | null;
}, user: string): Promise<CaseRuntime> {
  // executionId 优先；skill 评测接入只带 taskId(=sessionId) 时按 taskId 兜底解析 Execution，
  // 以拿到 skill 上下文与 finalResult（actualOutput 兜底）。
  const execution = caseRow.executionId
    ? await prisma.execution.findUnique({ where: { id: caseRow.executionId } })
    : caseRow.taskId
    ? await prisma.execution.findFirst({ where: { taskId: caseRow.taskId } })
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

  // input/actualOutput 兜底：ExperimentCase 字段为空时（skill 评测接入只传 taskId）
  // 用 Execution.query / Execution.finalResult 兜底（trace 模式无 dataset case）。
  const caseInput = caseRow.input || execution?.query || '';
  const actualOutput = caseRow.actualOutput || execution?.finalResult || '';
  const evaluatorContextResult = parseStoredEvaluatorCaseContext(caseRow.evaluatorContextJson);

  const judgeCtx: JudgeCaseContext = {
    input: caseInput,
    output: actualOutput,
    referenceOutput: caseRow.referenceOutput,
    trajectory,
  };

  const faithfulCtx: FaithfulPresetContext = {
    caseInput,
    actualOutput,
    referenceOutput: caseRow.referenceOutput,
    traceSummaryText: trajectory,
    interactions: rawInteractions,
    evaluatorContext: evaluatorContextResult.context,
    evaluatorContextError: evaluatorContextResult.error,
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
  // 内容、安全与创意预置评估器：LLM Judge 直连（共用 faithfulCtx，与 §4.3 签名一致）
  if (isContentPresetId(evaluatorId)) {
    return runContentPreset(evaluatorId, user, runtime.faithfulCtx);
  }
  if (isCreativityPresetId(evaluatorId)) {
    return runCreativityPreset(evaluatorId, user, runtime.faithfulCtx);
  }
  if (isSafetyPresetId(evaluatorId)) {
    return runSafetyPreset(evaluatorId, user, runtime.faithfulCtx);
  }
  if (isDepthPresetId(evaluatorId)) {
    return runDepthPreset(user, runtime.faithfulCtx);
  }
  if (isAgentToolPresetId(evaluatorId)) {
    return runAgentToolPreset(evaluatorId, user, runtime.faithfulCtx);
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
          verdict: out.verdict ?? null,
          summary: out.summary ?? null,
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

const RESULT_RUNS_KEY = Symbol.for('agent-insight.experiment.result-runs');
function getResultRuns(): Map<string, Promise<void>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<void>>>;
  if (!g[RESULT_RUNS_KEY]) g[RESULT_RUNS_KEY] = new Map<string, Promise<void>>();
  return g[RESULT_RUNS_KEY];
}

const ROW_LIMITER_KEY = Symbol.for('agent-insight.experiment.row-limiter');
function getRowLimiter(): SimpleAsyncLimiter {
  const g = globalThis as unknown as Record<symbol, SimpleAsyncLimiter>;
  if (!g[ROW_LIMITER_KEY]) {
    g[ROW_LIMITER_KEY] = createSimpleAsyncLimiter(experimentEngineConfig.concurrency);
  }
  return g[ROW_LIMITER_KEY];
}

const KEYED_LOCKS_KEY = Symbol.for('agent-insight.experiment.keyed-locks');
function getKeyedLocks(): Map<string, Promise<void>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<void>>>;
  if (!g[KEYED_LOCKS_KEY]) g[KEYED_LOCKS_KEY] = new Map<string, Promise<void>>();
  return g[KEYED_LOCKS_KEY];
}

async function withKeyedLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const locks = getKeyedLocks();
  const previous = locks.get(key) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => gate);
  locks.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

async function settleExperimentStatus(experimentId: string): Promise<void> {
  const rows = await prisma.experimentEvalResult.findMany({
    where: { experimentId },
    select: { status: true },
  });
  const anyPending = rows.some((r: { status: string }) => r.status === 'pending' || r.status === 'running');
  if (anyPending) return; // 尚未全部终态（单项 retry 场景下可能仍有 running）
  const anyDone = rows.some((r: { status: string }) => r.status === 'done');
  await prisma.experiment.updateMany({
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

    const scheduledRows: ScheduledResultRun[] = [];
    for (const c of experiment.cases) {
      for (const evaluatorId of evaluatorIds) {
        scheduledRows.push(await resetAndScheduleResultRun({
          experimentId, caseId: c.id, evaluatorId, user,
        }));
      }
    }

    // 每行完成后立刻 settle：避免「行已 done、实验仍 running」的观察窗口（轮询/单测会踩中）。
    const completion = Promise.all(
      scheduledRows.map((row) => row.completion.then(() => settleExperimentStatus(experimentId))),
    ).finally(() => { running.delete(experimentId); });
    return { status: 'running', completion };
  } catch (e) {
    running.delete(experimentId);
    throw e;
  }
}

function getOrStartResultRun(user: string, resultId: string): Promise<void> {
  const resultRuns = getResultRuns();
  const existing = resultRuns.get(resultId);
  if (existing) return existing;

  const limiter = getRowLimiter();
  const execution = (async () => {
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
  })();
  const tracked = execution.finally(() => {
    if (resultRuns.get(resultId) === tracked) resultRuns.delete(resultId);
  });
  resultRuns.set(resultId, tracked);
  return tracked;
}

interface ScheduledResultRun {
  resultId: string;
  completion: Promise<void>;
}

async function resetAndScheduleResultRun(params: {
  experimentId: string;
  caseId: string;
  evaluatorId: string;
  user: string;
}): Promise<ScheduledResultRun> {
  return withKeyedLock(`eval-result:${params.caseId}:${params.evaluatorId}`, async () => {
    const existingRow = await prisma.experimentEvalResult.findUnique({
      where: { caseId_evaluatorId: { caseId: params.caseId, evaluatorId: params.evaluatorId } },
      select: { id: true },
    });
    const existingRun = existingRow ? getResultRuns().get(existingRow.id) : undefined;
    if (existingRow && existingRun) {
      return { resultId: existingRow.id, completion: existingRun };
    }

    const row = await prisma.experimentEvalResult.upsert({
      where: { caseId_evaluatorId: { caseId: params.caseId, evaluatorId: params.evaluatorId } },
      create: {
        experimentId: params.experimentId,
        caseId: params.caseId,
        evaluatorId: params.evaluatorId,
        status: 'pending',
      },
      update: {
        status: 'pending', verdict: null, summary: null,
        score: null, pointsJson: null,
        evidenceJson: null, errorMessage: null, durationMs: null,
        humanScore: null, humanReason: null, humanBy: null, humanAt: null,
      },
      select: { id: true },
    });
    return { resultId: row.id, completion: getOrStartResultRun(params.user, row.id) };
  });
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
    select: { id: true, caseId: true, evaluatorId: true },
  });
  if (!row) return null;

  const scheduled = await resetAndScheduleResultRun({
    experimentId,
    caseId: row.caseId,
    evaluatorId: row.evaluatorId,
    user,
  });
  await scheduled.completion;
  const settledRow = await prisma.experimentEvalResult.findUnique({
    where: { id: resultId },
    select: { status: true },
  });
  await settleExperimentStatus(experimentId);
  return settledRow?.status === 'done' ? 'done' : 'failed';
}

// ── Skill 评测接入：把一次评测会话建成/复用一个单组实验（纯评测后端）──────────
// 设计（与产品对齐）：运行 Agent（跑 skill 版本）与 A/B 对比聚合仍由 skill 侧负责；
// 实验只承担「评测」这一段——trace 产生后逐个作为 case 加入同一 backing experiment，
// 复用 executeResultRow 同步跑评估器、读回结果供 skill 侧回填自己的状态。不改 schema、
// 不做对比、不执行 Agent；一个批次/AB 任务 ↔ 一个实验。

/** 单个 case 评测读回结构（每个评估器一行）。 */
export interface EvalCaseResultRow {
  evaluatorId: string;
  status: string;
  score: number | null;
  pointsJson: string | null;
  evidenceJson: string | null;
  errorMessage: string | null;
}

export interface StartEvalExperimentCasesResult {
  status: 'running';
  completion: Promise<void>;
}

/** 建/取一个作评测后端的单组实验（给定 existingId 且属本人则复用，否则新建 running 态）。
 *  scope/skillName/skillVersion 用于评测任务列表按来源+skill 过滤（见 /api/experiments/eval-runs）。 */
export async function ensureEvalExperiment(params: {
  user: string;
  name: string;
  agentName?: string | null;
  evaluatorIds: string[];
  existingId?: string | null;
  scope?: string;
  skillName?: string | null;
  skillVersion?: number | null;
}): Promise<string> {
  if (params.existingId) {
    const found = await prisma.experiment.findFirst({
      where: { id: params.existingId, user: params.user },
      select: { id: true },
    });
    if (found) return found.id;
  }
  const exp = await prisma.experiment.create({
    data: {
      user: params.user,
      name: params.name,
      type: 'single',
      agentName: params.agentName ?? '',
      evaluatorIdsJson: JSON.stringify(params.evaluatorIds),
      // 建出来时还没有任何 case/结果，不是「运行中」——空评测任务(createOnly 0 trace)
      // 若建成 running 会永久卡住(settleExperimentStatus 只在评完某 case 后才落终态)。
      // 真正评估时每个 case 评完经 settleExperimentStatus 落到 done/failed。
      status: 'draft',
      scope: params.scope ?? '',
      skillName: params.skillName ?? '',
      skillVersion: params.skillVersion ?? null,
    },
    select: { id: true },
  });
  return exp.id;
}

/** 往评测实验加一个 case（trace 已产生），返回 caseId。
 * 按 taskId 幂等：同一实验内该 trace 已有 case 就复用（并回填新拿到的参考答案），
 * 避免同一 trace 被重复评测时建出重复 case。 */
export async function addEvalExperimentCase(
  experimentId: string,
  c: {
    executionId?: string | null;
    taskId?: string | null;
    input: string;
    actualOutput: string;
    referenceOutput?: string | null;
    evaluatorContext?: EvaluatorCaseContext | null;
  },
): Promise<string> {
  const createOrReuse = async (): Promise<string> => {
    if (c.taskId) {
      const existing = await prisma.experimentCase.findFirst({
        where: { experimentId, taskId: c.taskId },
        select: { id: true },
      });
      if (existing) {
        // 复用已有 case；若这次拿到了参考答案或评估器上下文则回填。
        if (
          (c.referenceOutput != null && String(c.referenceOutput).trim())
          || c.evaluatorContext !== undefined
        ) {
          await prisma.experimentCase.update({
            where: { id: existing.id },
            data: {
              ...(c.referenceOutput != null && String(c.referenceOutput).trim()
                ? { referenceOutput: c.referenceOutput }
                : {}),
              ...(c.evaluatorContext !== undefined
                ? {
                    evaluatorContextJson: c.evaluatorContext
                      ? JSON.stringify(normalizeEvaluatorCaseContext(c.evaluatorContext))
                      : null,
                  }
                : {}),
            },
          });
        }
        return existing.id;
      }
    }
    const row = await prisma.experimentCase.create({
      data: {
        experimentId,
        executionId: c.executionId ?? null,
        taskId: c.taskId ?? null,
        input: c.input,
        actualOutput: c.actualOutput,
        referenceOutput: c.referenceOutput ?? null,
        evaluatorContextJson: c.evaluatorContext
          ? JSON.stringify(normalizeEvaluatorCaseContext(c.evaluatorContext))
          : null,
      },
      select: { id: true },
    });
    return row.id;
  };

  return c.taskId
    ? withKeyedLock(`eval-case:${experimentId}:${c.taskId}`, createOrReuse)
    : createOrReuse();
}

/**
 * 预创建指定 case 的全部结果行并在后台并发执行。
 *
 * 与 startExperimentRun 不同，这里只重置本次传入的 case，适合向已有评测任务追加 Trace；
 * 其它 case 的历史结果保持不变。全部结果行会在 completion 启动前落库，调用方可以立即
 * 返回，让前端一次看到整批 pending/running 记录。运行中的同一结果行会复用已有 Promise，
 * 不重置、不重复调用评估器；所有实验共用同一个行级并发池。
 */
export async function startEvalExperimentCases(
  experimentId: string,
  caseIds: string[],
  user: string,
): Promise<StartEvalExperimentCasesResult | null> {
  return withKeyedLock(`eval-start:${experimentId}`, async () => {
    const experiment = await prisma.experiment.findFirst({
      where: { id: experimentId, user },
      select: { evaluatorIdsJson: true },
    });
    if (!experiment) return null;

    let evaluatorIds: string[] = [];
    try {
      const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
      if (Array.isArray(parsed)) evaluatorIds = parsed.map(String).filter(Boolean);
    } catch { /* 忽略脏数据 */ }

    const uniqueCaseIds = Array.from(new Set(caseIds.map(String).filter(Boolean)));
    const ownedCases = await prisma.experimentCase.findMany({
      where: { experimentId, id: { in: uniqueCaseIds } },
      select: { id: true },
    });
    if (!evaluatorIds.length || !ownedCases.length) {
      throw new Error(`实验 ${experimentId} 缺少可执行的 case 或评估器`);
    }

    await prisma.experiment.update({
      where: { id: experimentId },
      data: { status: 'running' },
    });
    const scheduledRows: ScheduledResultRun[] = [];
    for (const c of ownedCases) {
      for (const evaluatorId of evaluatorIds) {
        scheduledRows.push(await resetAndScheduleResultRun({
          experimentId, caseId: c.id, evaluatorId, user,
        }));
      }
    }

    // 每行完成后立刻 settle：最后一行 done 时实验终态已落库，与行状态无可见窗口。
    const completion = Promise.all(
      scheduledRows.map((row) => row.completion.then(() => settleExperimentStatus(experimentId))),
    );
    return { status: 'running', completion };
  });
}

/** 评测一个 case（× 实验的全部 evaluatorIds），同步跑完并读回每个评估器的结果行。 */
export async function evaluateEvalExperimentCase(
  experimentId: string,
  caseId: string,
  user: string,
): Promise<EvalCaseResultRow[]> {
  const experiment = await prisma.experiment.findFirst({
    where: { id: experimentId, user },
    select: { evaluatorIdsJson: true },
  });
  if (!experiment) throw new Error(`实验 ${experimentId} 不存在`);
  let evaluatorIds: string[] = [];
  try {
    const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
    if (Array.isArray(parsed)) evaluatorIds = parsed.map(String).filter(Boolean);
  } catch { /* 忽略脏数据 */ }

  const out: EvalCaseResultRow[] = [];
  for (const evaluatorId of evaluatorIds) {
    const scheduled = await resetAndScheduleResultRun({
      experimentId, caseId, evaluatorId, user,
    });
    await scheduled.completion;
    const done = await prisma.experimentEvalResult.findUnique({
      where: { id: scheduled.resultId },
      select: { evaluatorId: true, status: true, score: true, pointsJson: true, evidenceJson: true, errorMessage: true },
    });
    if (done) out.push(done);
  }
  await settleExperimentStatus(experimentId);
  return out;
}
