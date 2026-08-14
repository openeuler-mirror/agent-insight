/**
 * 对比 runner：在冻结的单组引擎之上加「对比」层。
 *
 * - createComparisonExperiment: 1 个 Experiment(type='llm') + N 个 ExperimentGroup
 * - autoPairGroups: 按维度查候选 trace → O(N) hash-join by query → 三条件判定 → 为可比配对创建两侧 case
 * - judgeComparability: 纯函数，三条件可比性判定（AC-004）
 * - getComparisonDetail: 按组切片调 detail-agg 纯函数 + 算配对表 + 可比率 + 组汇总
 *
 * 冻结区：不修改 run-experiment.ts 非导出内部；仅复用 executeResultRow（T004）。
 * 独立 Symbol.for key（T004）；终态谓词同款逻辑自实现（T004）。
 */
import { prisma } from '@/lib/storage/prisma';
import { getDimension, type VariableDimension, type DimensionTrace, type TraceCandidate } from './variable-dimension';
import {
  overallAverage,
  evaluatorBreakdown,
  caseScore,
  type ResultRowLike,
  type CategoryOf,
  type EvaluatorBreakdownRow,
} from './detail-agg';
import { executeResultRow } from './run-experiment';
import { createSimpleAsyncLimiter } from '../evaluation/eval-run-guards';
import { getEvaluatorMeta, type EvaluatorCategory } from '@/lib/evaluators/registry';
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';
import { readUserCustomEvaluators } from '@/server/user_evaluators_storage';
import type { EvaluatorCard } from '@/lib/evaluators/custom-evaluator-model';

const COMPARABLE_RATE_THRESHOLD = Number(process.env.COMPARABLE_RATE_THRESHOLD ?? 0.7);
const CASE_PAGE_SIZE_DEFAULT = 8;

/** 对比 runner 引擎配置（仿 experimentEngineConfig；NFR-004 一致性口径）。 */
export const comparisonEngineConfig = {
  retryDelaysMs: [2_000, 8_000] as number[],
  rowTimeoutMs: 300_000,
  concurrency: Number(process.env.COMPARISON_CONCURRENCY ?? 4),
};

// ─── 防重入（独立 Symbol.for key，不复用单组 key）────────────────────────────

const COMPARISON_RUNNING_KEY = Symbol.for('agent-insight.comparison.running-set');
function getComparisonRunningSet(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[COMPARISON_RUNNING_KEY]) g[COMPARISON_RUNNING_KEY] = new Set();
  return g[COMPARISON_RUNNING_KEY]!;
}

// ─── 类型 ───────────────────────────────────────────────────────────────────

export interface ComparisonGroupInput {
  key: string;
  value: string;
}

export type PairStatus = '可比' | '未配对' | '不可比';

export interface ComparabilityResult {
  status: PairStatus;
  reason: string | null;
}

/** 配对一侧的 case + trace 信息（可比时有值）。 */
export interface PairSide {
  caseId: string;
  executionId: string | null;
  actualOutput: string;
  scores: { overall: number | null; res: number | null; traj: number | null };
}

export interface PairingEntry {
  taskInput: string;
  a: PairSide | null;
  b: PairSide | null;
  verdict: 'A胜' | 'B胜' | '平' | 'N/A';
  status: PairStatus;
  reason: string | null;
}

export interface PairingData {
  items: PairingEntry[];
  total: number;
  comparableCount: number;
  comparableRate: number;
  degraded: boolean;
}

export interface GroupSummary {
  key: string;
  variableValue: string;
  overall: number | null;
  breakdown: EvaluatorBreakdownRow[];
  progress: { total: number; done: number; failed: number; pending: number };
  successRate: number | null;
  avgCost: number | null;
  avgLatency: number | null;
  avgSteps: number | null;
}

export interface ComparisonDetailData {
  id: string;
  name: string;
  type: string;
  agentName: string;
  status: string;
  watchMode: boolean;
  watchEnabledAt: Date | null;
  evaluatorIds: string[];
  createdAt: Date;
  overall: number | null;
  breakdown: EvaluatorBreakdownRow[];
  progress: { total: number; done: number; failed: number; pending: number };
  caseTotal: number;
  casePage: number;
  casePageSize: number;
  groups: GroupSummary[];
  pairing: PairingData;
}

/** 内部：computePairs 返回的原始配对（trace 级，未关联 case）。 */
interface RawPair {
  taskInput: string;
  a: TraceCandidate | null;
  b: TraceCandidate | null;
  status: PairStatus;
  reason: string | null;
}

// ─── judgeComparability（纯函数，AC-004）─────────────────────────────────────

/** null 归一：null→null（保持 null 语义；G2：两 null=相等，null vs 值=不可比）。 */
function normalizeNull<T>(v: T | null | undefined): T | null {
  return v ?? null;
}

/**
 * 三条件可比性判定（FR-004 / AC-004）：
 * 1. 双侧 trace 齐全（否则「未配对」）
 * 2. 双侧变量取值匹配各自组值（否则「不可比」）
 * 3. 受控字段跨组一致（否则「不可比」+ 标注字段）
 */
export function judgeComparability(
  a: DimensionTrace | null,
  b: DimensionTrace | null,
  dimension: VariableDimension,
  groupAValue: string,
  groupBValue: string,
): ComparabilityResult {
  if (!a || !b) {
    return { status: '未配对', reason: '一侧缺 trace' };
  }
  if (dimension.extractValue(a) !== groupAValue) {
    return { status: '不可比', reason: 'A 组取值不匹配' };
  }
  if (dimension.extractValue(b) !== groupBValue) {
    return { status: '不可比', reason: 'B 组取值不匹配' };
  }
  for (const { field } of dimension.controlledFields()) {
    const av = normalizeNull(a[field as keyof DimensionTrace]);
    const bv = normalizeNull(b[field as keyof DimensionTrace]);
    if (av !== bv) {
      return { status: '不可比', reason: `${field} 不一致` };
    }
  }
  return { status: '可比', reason: null };
}

// ─── computePairs（共享内部：查候选 + 配对 + 判定）──────────────────────────

/**
 * 按维度查每组候选 trace → O(N) hash-join by query → 三条件判定。
 * autoPairGroups 与 getComparisonDetail 共用：前者据此创建 case，后者据此算配对表+可比率。
 */
export async function computePairs(
  experimentId: string,
): Promise<{ pairs: RawPair[]; groupByKey: Map<string, { group: { id: string; key: string; variableValue: string }; dimension: VariableDimension }> }> {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    include: { groups: true },
  });
  if (!experiment) throw new Error(`experiment ${experimentId} not found`);
  if (experiment.type === 'single' || !experiment.agentName) {
    return { pairs: [], groupByKey: new Map() };
  }
  const dimension = getDimension(experiment.type);
  if (!dimension) {
    return { pairs: [], groupByKey: new Map() };
  }

  const groupByKey = new Map<string, { group: { id: string; key: string; variableValue: string }; dimension: VariableDimension }>();
  const candidatesByKey = new Map<string, TraceCandidate[]>();
  for (const g of experiment.groups) {
    groupByKey.set(g.key, { group: g, dimension });
    const traces = await dimension.queryCandidateTraces(experiment.agentName, g.variableValue);
    if (traces.length === 0) {
      throw new Error(`${g.key} 组无任何匹配 trace`);
    }
    candidatesByKey.set(g.key, traces);
  }

  // O(N) hash-join by query（任务输入）
  const indexByQuery = new Map<string, Map<string, TraceCandidate[]>>();
  for (const [key, traces] of candidatesByKey) {
    for (const t of traces) {
      const q = t.query ?? '';
      if (!indexByQuery.has(q)) indexByQuery.set(q, new Map());
      const byGroup = indexByQuery.get(q)!;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(t);
    }
  }

  // 取每组首个候选（queryCandidateTraces 已按 timestamp desc 排序 → 首个=最新）
  const groupKeys = Array.from(groupByKey.keys());
  const groupAKey = groupKeys[0];
  const groupBKey = groupKeys[1] ?? groupKeys[0];
  const groupA = groupByKey.get(groupAKey)!.group;
  const groupB = groupByKey.get(groupBKey)!.group;

  const pairs: RawPair[] = [];
  for (const [query, byGroup] of indexByQuery) {
    const aList = byGroup.get(groupAKey) ?? [];
    const bList = byGroup.get(groupBKey) ?? [];
    const a = aList[0] ?? null;
    const b = bList[0] ?? null;
    const result = judgeComparability(a, b, dimension, groupA.variableValue, groupB.variableValue);
    pairs.push({ taskInput: query, a, b, status: result.status, reason: result.reason });
  }

  return { pairs, groupByKey };
}

// ─── createComparisonExperiment ─────────────────────────────────────────────

export interface CreateComparisonParams {
  user: string;
  name: string;
  agentName: string;
  variableDimension: string;
  groups: ComparisonGroupInput[];
  evaluatorIds: string[];
  watchMode?: boolean;
}

/**
 * 创建对比实验：1 个 Experiment(type='llm') + 嵌套 ExperimentGroup rows。
 * variableDimension 参数与 type 1:1 映射（本期 type='llm' ↔ LLM 维度）；存 type，维度由 getDimension 派生。
 */
export async function createComparisonExperiment(params: CreateComparisonParams): Promise<{ id: string }> {
  const { user, name, agentName, groups, evaluatorIds, watchMode } = params;
  // variableDimension 与 type 1:1 映射（本期 type='llm' ↔ LLM 维度）；维度由 getDimension(type) 派生，不单独存。

  if (groups.length < 2) {
    throw new Error('对比实验至少需要 2 个分组');
  }
  const values = groups.map((g) => g.value);
  if (new Set(values).size !== values.length) {
    throw new Error('分组取值不可相同');
  }
  if (watchMode) {
    throw new Error('对比实验不支持 watchMode');
  }

  const experiment = await prisma.experiment.create({
    data: {
      user,
      name,
      agentName,
      type: 'llm',
      scope: '',
      evaluatorIdsJson: JSON.stringify(evaluatorIds),
      status: 'draft',
      groups: {
        create: groups.map((g) => ({ key: g.key, variableValue: g.value })),
      },
    },
  });
  return { id: experiment.id };
}

// ─── autoPairGroups ─────────────────────────────────────────────────────────

/**
 * 自动配对：查候选 trace → 跨组配对 → 三条件判定 → 为可比配对创建两侧 case（各带 groupId）。
 * 空组校验：任一组 0 条候选 → throw（指明哪组）。
 */
export async function autoPairGroups(experimentId: string): Promise<RawPair[]> {
  const { pairs, groupByKey } = await computePairs(experimentId);
  const groupKeys = Array.from(groupByKey.keys());
  const groupAKey = groupKeys[0];
  const groupBKey = groupKeys[1] ?? groupKeys[0];
  const groupA = groupByKey.get(groupAKey)!.group;
  const groupB = groupByKey.get(groupBKey)!.group;

  for (const p of pairs) {
    if (p.status !== '可比') continue;
    // A 侧 case
    if (p.a) {
      await prisma.experimentCase.upsert({
        where: {
          experimentId_taskId_groupId: {
            experimentId,
            taskId: p.a.taskId ?? p.a.id,
            groupId: groupA.id,
          },
        },
        update: { executionId: p.a.id, input: p.taskInput },
        create: {
          experimentId,
          groupId: groupA.id,
          executionId: p.a.id,
          taskId: p.a.taskId ?? p.a.id,
          input: p.taskInput,
        },
      });
    }
    // B 侧 case
    if (p.b) {
      await prisma.experimentCase.upsert({
        where: {
          experimentId_taskId_groupId: {
            experimentId,
            taskId: p.b.taskId ?? p.b.id,
            groupId: groupB.id,
          },
        },
        update: { executionId: p.b.id, input: p.taskInput },
        create: {
          experimentId,
          groupId: groupB.id,
          executionId: p.b.id,
          taskId: p.b.taskId ?? p.b.id,
          input: p.taskInput,
        },
      });
    }
  }
  return pairs;
}

// ─── getComparisonDetail ────────────────────────────────────────────────────

/** 构建 categoryOf：preset 卡片 + 用户自建卡片 → getEvaluatorMeta(card).category。 */
async function buildCategoryOf(user: string): Promise<CategoryOf> {
  const byId = new Map<string, EvaluatorCard>();
  for (const card of presetEvaluators) byId.set(card.id, card);
  try {
    const customs = await readUserCustomEvaluators(user);
    for (const c of customs) {
      const card = c as EvaluatorCard;
      if (card && card.id) byId.set(card.id, card);
    }
  } catch { /* 拉不到自建卡片不阻塞——类目回退 'res' */ }
  return (evaluatorId: string): EvaluatorCategory => {
    const card = byId.get(evaluatorId);
    return card ? getEvaluatorMeta(card).category : 'res';
  };
}

/** 胜负判定：按综合分（一侧无分一侧有分→有分侧胜，AC-018）。 */
function computeVerdict(aOverall: number | null, bOverall: number | null): 'A胜' | 'B胜' | '平' | 'N/A' {
  const aHas = typeof aOverall === 'number';
  const bHas = typeof bOverall === 'number';
  if (!aHas && !bHas) return 'N/A';
  if (!aHas && bHas) return 'B胜';
  if (aHas && !bHas) return 'A胜';
  if (aOverall! > bOverall!) return 'A胜';
  if (bOverall! > aOverall!) return 'B胜';
  return '平';
}

/**
 * 对比详情：按组切片调 detail-agg 纯函数 + 算配对表 + 可比率降级 + 组汇总 5 指标。
 * 不可比/未配对不进任何组间统计分母（AC-021）—— autoPairGroups 只为可比配对创建 case，
 * 故 results 天然只含可比配对行，overallAverage 天然排除非可比。
 */
export async function getComparisonDetail(
  experimentId: string,
  opts: { casePage?: number; casePageSize?: number; caseId?: string },
): Promise<ComparisonDetailData> {
  const casePageSize = Math.min(Math.max(opts.casePageSize ?? CASE_PAGE_SIZE_DEFAULT, 1), 100);
  const casePageRaw = Math.max(opts.casePage ?? 1, 1);

  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    include: { groups: { orderBy: { key: 'asc' } } },
  });
  if (!experiment) throw new Error(`experiment ${experimentId} not found`);

  let evaluatorIds: string[] = [];
  try {
    const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
    if (Array.isArray(parsed)) evaluatorIds = parsed.map(String);
  } catch { /* 忽略脏数据 */ }

  const categoryOf = await buildCategoryOf(experiment.user);

  // 全量结果（轻量选列）
  const allResults: ResultRowLike[] = await prisma.experimentEvalResult.findMany({
    where: { experimentId },
    select: { caseId: true, evaluatorId: true, status: true, score: true },
  });
  const progress = {
    total: allResults.length,
    done: allResults.filter((r) => r.status === 'done').length,
    failed: allResults.filter((r) => r.status === 'failed').length,
    pending: allResults.filter((r) => r.status === 'pending' || r.status === 'running').length,
  };

  // 全量 case（按组分片）——显式类型避免 prisma 包装器 any 推断
  interface CaseWithResults {
    id: string;
    groupId: string | null;
    executionId: string | null;
    input: string;
    actualOutput: string;
    results: ResultRowLike[];
  }
  const allCases: CaseWithResults[] = await prisma.experimentCase.findMany({
    where: { experimentId },
    include: { results: { select: { id: true, caseId: true, evaluatorId: true, status: true, score: true } } },
  });

  // Execution 回填表（case.actualOutput 为空时用 execution.finalResult 兜底，与单组路由同款）
  const execFallback = new Map<string, string>();
  const needExecIds = allCases.filter((c) => !c.actualOutput && c.executionId).map((c) => c.executionId!);
  if (needExecIds.length) {
    const execs = await prisma.execution.findMany({
      where: { id: { in: needExecIds } },
      select: { id: true, finalResult: true },
    });
    for (const e of execs) execFallback.set(e.id, e.finalResult ?? '');
  }
  const caseTotal = allCases.length;
  const casePages = Math.max(1, Math.ceil(caseTotal / casePageSize));
  const casePage = Math.min(casePageRaw, casePages);

  // 按组切片算 overall/breakdown
  const groups: GroupSummary[] = [];
  for (const g of experiment.groups) {
    const groupCaseIds = new Set(allCases.filter((c) => c.groupId === g.id).map((c) => c.id));
    const groupRows = allResults.filter((r) => groupCaseIds.has(r.caseId));
    const overall = overallAverage(groupRows);
    const breakdown = evaluatorBreakdown(groupRows);
    const groupProgress = {
      total: groupRows.length,
      done: groupRows.filter((r) => r.status === 'done').length,
      failed: groupRows.filter((r) => r.status === 'failed').length,
      pending: groupRows.filter((r) => r.status === 'pending' || r.status === 'running').length,
    };

    // trace 天然指标（成本/时长/步数/成功率）——查该组 case 关联的 Execution
    const execIds = allCases
      .filter((c) => c.groupId === g.id && c.executionId)
      .map((c) => c.executionId!);
    let traceMetrics = { successRate: null as number | null, avgCost: null as number | null, avgLatency: null as number | null, avgSteps: null as number | null };
    if (execIds.length) {
      interface ExecMetrics { cost: number | null; latency: number | null; toolCallCount: number | null; isAnswerCorrect: boolean | null }
      const execs: ExecMetrics[] = await prisma.execution.findMany({
        where: { id: { in: execIds } },
        select: { cost: true, latency: true, toolCallCount: true, isAnswerCorrect: true },
      });
      const valid = execs.filter((e) => e.cost != null || e.latency != null || e.toolCallCount != null || e.isAnswerCorrect != null);
      if (valid.length) {
        const avg = (arr: (number | null)[]) => {
          const nums = arr.filter((v): v is number => typeof v === 'number');
          return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
        };
        const correct = execs.filter((e) => e.isAnswerCorrect === true).length;
        traceMetrics = {
          successRate: execs.length ? correct / execs.length : null,
          avgCost: avg(execs.map((e) => e.cost)),
          avgLatency: avg(execs.map((e) => e.latency)),
          avgSteps: avg(execs.map((e) => e.toolCallCount)),
        };
      }
    }

    groups.push({
      key: g.key,
      variableValue: g.variableValue,
      overall,
      breakdown,
      progress: groupProgress,
      ...traceMetrics,
    });
  }

  // 重算配对（取全部 pair + status + comparableRate）
  const { pairs } = await computePairs(experimentId);

  // 为可比配对关联 case + 算 per-case 得分
  const casesByInputGroup: Map<string, Map<string, (typeof allCases)[number]>> = new Map();
  for (const c of allCases) {
    const input = c.input || '';
    if (!casesByInputGroup.has(input)) casesByInputGroup.set(input, new Map());
    if (c.groupId) casesByInputGroup.get(input)!.set(c.groupId, c);
  }

  const pairingItems: PairingEntry[] = pairs.map((p) => {
    let aSide: PairSide | null = null;
    let bSide: PairSide | null = null;
    const groupA = experiment.groups[0];
    const groupB = experiment.groups[1] ?? experiment.groups[0];
    if (groupA) {
      const caseA = casesByInputGroup.get(p.taskInput)?.get(groupA.id);
      if (caseA) {
        const rows = (caseA.results as unknown as ResultRowLike[]);
        const scores = caseScore(rows, categoryOf);
        const out = caseA.actualOutput || (caseA.executionId ? execFallback.get(caseA.executionId) ?? '' : '');
        aSide = { caseId: caseA.id, executionId: caseA.executionId, actualOutput: out, scores: { overall: scores.overall, res: scores.res, traj: scores.traj } };
      }
    }
    if (groupB) {
      const caseB = casesByInputGroup.get(p.taskInput)?.get(groupB.id);
      if (caseB) {
        const rows = (caseB.results as unknown as ResultRowLike[]);
        const scores = caseScore(rows, categoryOf);
        const out = caseB.actualOutput || (caseB.executionId ? execFallback.get(caseB.executionId) ?? '' : '');
        bSide = { caseId: caseB.id, executionId: caseB.executionId, actualOutput: out, scores: { overall: scores.overall, res: scores.res, traj: scores.traj } };
      }
    }
    const aOverall = aSide?.scores.overall ?? null;
    const bOverall = bSide?.scores.overall ?? null;
    const verdict = p.status === '可比' ? computeVerdict(aOverall, bOverall) : 'N/A';
    return { taskInput: p.taskInput, a: aSide, b: bSide, verdict, status: p.status, reason: p.reason };
  });

  // 配对表分页（仅可比进分页；未配对/不可比单列不进）
  const comparableItems = pairingItems.filter((p) => p.status === '可比');
  const nonComparableItems = pairingItems.filter((p) => p.status !== '可比');
  const total = pairingItems.length;
  const comparableCount = comparableItems.length;
  const comparableRate = total > 0 ? comparableCount / total : 0;
  const degraded = comparableRate < COMPARABLE_RATE_THRESHOLD;

  // 分页可比配对
  const pagedComparable = comparableItems.slice((casePage - 1) * casePageSize, casePage * casePageSize);
  const pagedItems = [...pagedComparable, ...nonComparableItems];

  return {
    id: experiment.id,
    name: experiment.name,
    type: experiment.type,
    agentName: experiment.agentName,
    status: experiment.status,
    watchMode: experiment.watchMode,
    watchEnabledAt: experiment.watchEnabledAt,
    evaluatorIds,
    createdAt: experiment.createdAt,
    overall: null, // 对比模式无单一 overall——用 groups[].overall
    breakdown: [], // 对比模式无单一 breakdown——用 groups[].breakdown
    progress,
    caseTotal,
    casePage,
    casePageSize,
    groups,
    pairing: { items: pagedItems, total, comparableCount, comparableRate, degraded },
  };
}

// ─── startComparisonRun + settleComparisonStatus + rescanComparison ─────────

export interface StartComparisonRunResult {
  status: string;
  alreadyRunning?: boolean;
  completion?: Promise<void>;
}

/** 终态谓词（同款 PATTERN，独立实现非导出；G7 不复用单组内部）。任一 pending/running→return；anyDone→'done' else 'failed'。 */
async function settleComparisonStatus(experimentId: string): Promise<void> {
  const rows: { status: string }[] = await prisma.experimentEvalResult.findMany({
    where: { experimentId },
    select: { status: true },
  });
  const anyPending = rows.some((r) => r.status === 'pending' || r.status === 'running');
  if (anyPending) return;
  const anyDone = rows.some((r) => r.status === 'done');
  await prisma.experiment.update({
    where: { id: experimentId },
    data: { status: anyDone ? 'done' : 'failed' },
  });
}

/** 逐行调冻结的 executeResultRow（REUSE 不改；NFR-004 评分口径一致）。 */
async function comparisonRunAllRows(
  experimentId: string,
  user: string,
  resultIds: string[],
): Promise<void> {
  const limiter = createSimpleAsyncLimiter(comparisonEngineConfig.concurrency);
  await Promise.all(
    resultIds.map(async (resultId) => {
      await limiter.acquire();
      try {
        await executeResultRow(user, resultId);
      } finally {
        limiter.release();
      }
    }),
  );
  await settleComparisonStatus(experimentId);
}

/**
 * 启动对比运行：防重入（独立 Symbol.for key + DB status 双层）→ 置 running →
 * 为每个 (case × evaluator) upsert pending 行 → 逐行 executeResultRow → 终态写回。
 * fire-and-forget + completion 契约（仿 startExperimentRun；G4 保持 200+alreadyRunning）。
 */
export async function startComparisonRun(
  experimentId: string,
  user: string,
): Promise<StartComparisonRunResult | null> {
  const running = getComparisonRunningSet();
  if (running.has(experimentId)) {
    return { status: 'running', alreadyRunning: true };
  }

  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    include: { groups: true },
  });
  if (!experiment) return null;

  if (experiment.status === 'running') {
    return { status: 'running', alreadyRunning: true };
  }

  running.add(experimentId);
  await prisma.experiment.update({ where: { id: experimentId }, data: { status: 'running' } });

  // 为每个 (case × evaluator) upsert pending 行
  let evaluatorIds: string[] = [];
  try {
    const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
    if (Array.isArray(parsed)) evaluatorIds = parsed.map(String);
  } catch { /* 忽略脏数据 */ }

  const cases = await prisma.experimentCase.findMany({
    where: { experimentId },
    select: { id: true },
  });
  const resultIds: string[] = [];
  for (const c of cases) {
    for (const evaluatorId of evaluatorIds) {
      const row = await prisma.experimentEvalResult.upsert({
        where: { caseId_evaluatorId: { caseId: c.id, evaluatorId } },
        create: { experimentId, caseId: c.id, evaluatorId, status: 'pending' },
        update: { status: 'pending', score: null, errorMessage: null },
        select: { id: true },
      });
      resultIds.push(row.id);
    }
  }

  const completion = comparisonRunAllRows(experimentId, user, resultIds).finally(() => {
    running.delete(experimentId);
  });
  return { status: 'running', completion };
}

/**
 * 增量重扫：重算配对 → 找新可比配对（之前未配对、现在两侧都有 trace）→
 * 创建 case + pending 行 + 增量评测 → 重新聚合。
 * 运行中抛 409 互斥；已可比配对若 trace 删/字段漂移 → 降级标记（不删 case）。
 */
export async function rescanComparison(
  experimentId: string,
  user: string,
): Promise<{ newPairsCount: number; downgradedPairs: number }> {
  const experiment = await prisma.experiment.findUnique({
    where: { id: experimentId },
    include: { groups: { orderBy: { key: 'asc' } } },
  });
  if (!experiment) throw new Error(`experiment ${experimentId} not found`);
  if (experiment.status === 'running') {
    throw new Error('experiment is running (409)');
  }

  // 重算配对
  const { pairs, groupByKey } = await computePairs(experimentId);
  const groupKeys = Array.from(groupByKey.keys());
  const groupAKey = groupKeys[0];
  const groupBKey = groupKeys[1] ?? groupKeys[0];
  const groupA = groupByKey.get(groupAKey)!.group;
  const groupB = groupByKey.get(groupBKey)!.group;

  // 现有 case（按 input + groupId 索引）
  interface CaseRef { id: string; input: string; groupId: string | null }
  const existingCases: CaseRef[] = await prisma.experimentCase.findMany({
    where: { experimentId },
    select: { id: true, input: true, groupId: true },
  });
  const existingIndex = new Map<string, Set<string>>();
  for (const c of existingCases) {
    const key = `${c.input || ''}|${c.groupId || ''}`;
    if (!existingIndex.has(key)) existingIndex.set(key, new Set());
    existingIndex.get(key)!.add(c.id);
  }

  let evaluatorIds: string[] = [];
  try {
    const parsed = JSON.parse(experiment.evaluatorIdsJson || '[]');
    if (Array.isArray(parsed)) evaluatorIds = parsed.map(String);
  } catch { /* 忽略脏数据 */ }

  // 找新可比配对（之前未配对、现在两侧都有 trace 且受控字段一致）
  const newResultIds: string[] = [];
  let newPairsCount = 0;
  let downgradedPairs = 0;

  for (const p of pairs) {
    const aKey = `${p.taskInput}|${groupA.id}`;
    const bKey = `${p.taskInput}|${groupB.id}`;
    const hadCasesA = existingIndex.has(aKey);
    const hadCasesB = existingIndex.has(bKey);

    if (p.status === '可比') {
      // 新可比配对（之前无 case）
      if (!hadCasesA && p.a) {
        const c = await prisma.experimentCase.create({
          data: {
            experimentId, groupId: groupA.id, executionId: p.a.id,
            taskId: p.a.taskId ?? p.a.id, input: p.taskInput,
          },
          select: { id: true },
        });
        for (const evaluatorId of evaluatorIds) {
          const r = await prisma.experimentEvalResult.create({
            data: { experimentId, caseId: c.id, evaluatorId, status: 'pending' },
            select: { id: true },
          });
          newResultIds.push(r.id);
        }
      }
      if (!hadCasesB && p.b) {
        const c = await prisma.experimentCase.create({
          data: {
            experimentId, groupId: groupB.id, executionId: p.b.id,
            taskId: p.b.taskId ?? p.b.id, input: p.taskInput,
          },
          select: { id: true },
        });
        for (const evaluatorId of evaluatorIds) {
          const r = await prisma.experimentEvalResult.create({
            data: { experimentId, caseId: c.id, evaluatorId, status: 'pending' },
            select: { id: true },
          });
          newResultIds.push(r.id);
        }
      }
      if (!hadCasesA || !hadCasesB) newPairsCount++;
    } else {
      // 降级：之前有 case（可比）但现在不可比/未配对
      if (hadCasesA && hadCasesB) downgradedPairs++;
    }
  }

  // 增量评测
  if (newResultIds.length > 0) {
    const running = getComparisonRunningSet();
    running.add(experimentId);
    await prisma.experiment.update({ where: { id: experimentId }, data: { status: 'running' } });
    try {
      await comparisonRunAllRows(experimentId, user, newResultIds);
    } finally {
      running.delete(experimentId);
    }
  }

  return { newPairsCount, downgradedPairs };
}
