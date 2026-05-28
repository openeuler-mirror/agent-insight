// Skill A/B 评分体系（v2.1）的唯一计算入口。
//
// 完整算法说明与公式推导见 docs/skill-ab-scoring.md。本文件做两件事：
//   1. 把 caseStates 折成 A/B 两组 terminal runs, 计算能力/成本/稳定性三个 0-100 分;
//   2. 把每个分数的中间步骤一并 return（`breakdown.steps`），灰度页 Card 3 直接渲染,
//      用户看到分数时能从 UI 一路下钻到原始评测分/Token/触发率。
//
// 想换阈值就改 DEFAULT_AB_SCORING_POLICY 或传 options.policy。policy.version 写入返回结果,
// 历史回放和策略升级时根据 version 区分。

export type AbTone = 'green' | 'amber' | 'red' | 'gray';

export type AbDimensionVerdict =
  | 'good'
  | 'warning'
  | 'reject'
  | 'revise-description'
  | 'unreliable'
  | 'insufficient'
  | 'unavailable'
  | 'data-quality';

export type AbDecision = 'direct-release' | 'monitor-release' | 'reject' | 'insufficient';

export interface AbScoringRun {
  status?: string;
  score?: number;
  pass?: number;
  timeCost?: string | number;
  tokenUsage?: number;
  skillTriggered?: boolean;
  toolCallCount?: number;
  runs?: AbScoringRun[];
}

export interface AbScoringCaseState {
  a?: AbScoringRun;
  b?: AbScoringRun;
}

export interface AbScoringPolicy {
  version: string;
  // 样本量门槛
  minSampleSize: number;             // N < 此值 → 'insufficient'
  recommendedSampleSize: number;     // 推荐样本量, UI 用来提示
  minRepeats: number;                // 计算方差的最小重复次数
  // 能力分（§3.1）
  capabilityScoreNeutral: number;    // Δscore = 0 时的能力分（50）
  capabilityScoreSlope: number;      // Δscore 每 +1 分对应能力分变化（2.5）
  capabilityGoodThreshold: number;   // 能力分判好下限（75）
  capabilityRejectThreshold: number; // 能力分判拒绝上限（50）
  // 成本分（§4.1）—— Δtoken 分段拐点
  costGoodPct: number;               // Δtoken 「好」上限对应 80 分（20%）
  costWarningPct: number;            // Δtoken 「警告」上限对应 40 分（100%）
  costRejectPct: number;             // Δtoken 「拒绝」下限对应 0 分（200%）
  costCouplingBonus: number;         // 能力 ≥ good 时成本加分（+15）
  costCouplingPenalty: number;       // 能力 < reject 时成本扣分（-20）
  costGoodThreshold: number;         // 成本分判好下限（70）
  costRejectThreshold: number;       // 成本分判拒绝上限（40）
  // 稳定性分（§5.1）
  varianceMax: number;               // 二项分布方差上限（0.25）
  stabilityGoodThreshold: number;    // 稳定性分判好下限（70）
  stabilityRejectThreshold: number;  // 稳定性分判拒绝上限（50）
  // 数据质量阈值
  capabilityDataQualityLowMax: number;  // A/B 评测均分都低于此值 → 数据集太难（5）
  capabilityDataQualityHighMin: number; // A/B 评测均分都高于此值 → 数据集太简单（95）
}

export interface AbScoreBreakdown {
  // 公式字符串，带实参代入。UI 用 mono 字体展示。
  formula: string;
  // 逐步计算的中间结果，每一步一行。
  steps: string[];
  // 指向 docs/skill-ab-scoring.md 对应小节，方便用户跳转查阅。
  reference: string;
}

export interface AbScoringResult {
  policyVersion: string;
  sampleSize: number;
  completedPairs: number;
  repeatRounds: number;
  confidence: 'low' | 'medium' | 'high';
  canScore: boolean;
  totalScore: number | null;
  totalScoreBreakdown: AbScoreBreakdown;
  grade: 'excellent' | 'good' | 'pass' | 'weak' | 'fail' | 'insufficient';
  gradeLabel: string;
  decision: AbDecision;
  decisionLabel: string;
  allowRelease: boolean;
  rejectCategory: 'capability' | 'cost' | 'stability' | null;
  // 命中的拒绝项列表（可能多于一个），第一个对应 rejectCategory。
  hardGates: Array<{ key: 'capability' | 'cost' | 'stability'; label: string }>;
  capability: {
    // 评测器百分制平均分（0-100），新口径主指标。
    avgEvalScoreA: number | null;
    avgEvalScoreB: number | null;
    deltaScore: number | null;
    // 通过率作为辅助指标（向下兼容 v1.1 报告与二元评测器）。
    passRateA: number | null;
    passRateB: number | null;
    deltaPp: number | null;
    score: number | null;
    verdict: AbDimensionVerdict;
    label: string;
    tone: AbTone;
    dataQualityIssue?: string;
    breakdown: AbScoreBreakdown;
  };
  cost: {
    avgTokensA: number | null;
    avgTokensB: number | null;
    deltaTokenPct: number | null;
    avgDurationA: number | null;
    avgDurationB: number | null;
    deltaDurationPct: number | null;
    avgStepsA: number | null;
    avgStepsB: number | null;
    deltaStepsPct: number | null;
    // 未叠加能力耦合前的基础成本分。breakdown.steps 里会同时展示 baseCost 与最终 score。
    baseCost: number | null;
    score: number | null;
    verdict: AbDimensionVerdict;
    label: string;
    tone: AbTone;
    dataQualityIssue?: string;
    breakdown: AbScoreBreakdown;
  };
  stability: {
    invokeRate: number | null;
    variance: number | null;
    score: number | null;
    // 子指标分（不参与判定，仅 UI 辅助展示）
    invokeScore: number | null;
    varianceScore: number | null;
    verdict: AbDimensionVerdict;
    label: string;
    tone: AbTone;
    varianceComputable: boolean;
    dataQualityIssue?: string;
    breakdown: AbScoreBreakdown;
  };
}

export const DEFAULT_AB_SCORING_POLICY: AbScoringPolicy = {
  version: 'agent-skill-scoring-v2.1',
  // 规范推荐 minSampleSize=5 / minRepeats=3, 这里保留开发友好的 1/1 默认值,
  // 以便小数据集冒烟测试也能出结论。docs/skill-ab-scoring.md §8 标注了这一差异。
  minSampleSize: 1,
  recommendedSampleSize: 20,
  minRepeats: 1,
  capabilityScoreNeutral: 50,
  capabilityScoreSlope: 2.5,
  capabilityGoodThreshold: 75,
  capabilityRejectThreshold: 50,
  costGoodPct: 20,
  costWarningPct: 100,
  costRejectPct: 200,
  costCouplingBonus: 15,
  costCouplingPenalty: 20,
  costGoodThreshold: 70,
  costRejectThreshold: 40,
  varianceMax: 0.25,
  stabilityGoodThreshold: 70,
  stabilityRejectThreshold: 50,
  capabilityDataQualityLowMax: 5,
  capabilityDataQualityHighMin: 95,
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function parseSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return null;
  const match = value.match(/(\d+(?:\.\d+)?)\s*s?/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function flattenRuns(side: AbScoringRun | undefined): AbScoringRun[] {
  if (!side) return [];
  if (Array.isArray(side.runs) && side.runs.length > 0) return side.runs.flatMap(flattenRuns);
  const hasData = side.status === 'pass'
    || side.status === 'fail'
    || side.status === 'executed'
    || typeof side.score === 'number'
    || typeof side.pass === 'number'
    || typeof side.tokenUsage === 'number'
    || typeof side.timeCost === 'string'
    || typeof side.timeCost === 'number';
  return hasData ? [side] : [];
}

function isTerminal(run: AbScoringRun): boolean {
  return run.status === 'pass' || run.status === 'fail' || typeof run.score === 'number' || typeof run.pass === 'number';
}

// 评测器百分制原始分（0-100）。新口径直接用它做能力分输入。
function getEvalScore(run: AbScoringRun): number | null {
  if (typeof run.score === 'number' && Number.isFinite(run.score)) return run.score;
  if (typeof run.pass === 'number' && Number.isFinite(run.pass)) return run.pass;
  // 评测器只输出 pass/fail 时,把 status 映射到 0/100,与 v1.1 行为兼容。
  if (run.status === 'pass') return 100;
  if (run.status === 'fail') return 0;
  return null;
}

// 通过率维持二元口径（score>=60 视为通过），仅作辅助指标展示。
function isPassed(run: AbScoringRun): boolean | null {
  const score = getEvalScore(run);
  if (score == null) return null;
  return score >= 60;
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deltaPct(base: number | null, next: number | null): number | null {
  if (base == null || next == null || base <= 0) return null;
  return ((next - base) / base) * 100;
}

function passRate(runs: AbScoringRun[]): number | null {
  const passValues = runs.map(isPassed).filter((value): value is boolean => value != null);
  if (passValues.length === 0) return null;
  return passValues.filter(Boolean).length / passValues.length;
}

// 能力分（§3.1）: clamp(50 + Δscore × 2.5, 0, 100)
function capabilityScore(deltaScore: number | null, policy: AbScoringPolicy): number | null {
  if (deltaScore == null) return null;
  return clamp(policy.capabilityScoreNeutral + deltaScore * policy.capabilityScoreSlope, 0, 100);
}

// 成本分基础映射（§4.1）: 4 段分段线性。
// 0%→100, costGoodPct→80, costWarningPct→40, costRejectPct→0, 超过 reject 仍为 0。
function baseCostScore(deltaTokenPct: number | null, policy: AbScoringPolicy): number | null {
  if (deltaTokenPct == null) return null;
  if (deltaTokenPct <= 0) return 100;
  if (deltaTokenPct <= policy.costGoodPct) {
    // [0, good] : 100 → 80
    return 100 - (deltaTokenPct / policy.costGoodPct) * 20;
  }
  if (deltaTokenPct <= policy.costWarningPct) {
    // [good, warning] : 80 → 40
    const span = policy.costWarningPct - policy.costGoodPct;
    return 80 - ((deltaTokenPct - policy.costGoodPct) / span) * 40;
  }
  if (deltaTokenPct <= policy.costRejectPct) {
    // [warning, reject] : 40 → 0
    const span = policy.costRejectPct - policy.costWarningPct;
    return 40 - ((deltaTokenPct - policy.costWarningPct) / span) * 40;
  }
  return 0;
}

// 能力耦合（§4.1）: 能力高加分,能力差扣分,中段不动。
function applyCostCoupling(
  baseCost: number,
  capability: number | null,
  policy: AbScoringPolicy,
): number {
  if (capability == null) return clamp(baseCost, 0, 100);
  if (capability >= policy.capabilityGoodThreshold) {
    return clamp(baseCost + policy.costCouplingBonus, 0, 100);
  }
  if (capability < policy.capabilityRejectThreshold) {
    return clamp(baseCost - policy.costCouplingPenalty, 0, 100);
  }
  return clamp(baseCost, 0, 100);
}

function variance(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
}

function confidence(sampleSize: number): AbScoringResult['confidence'] {
  if (sampleSize >= 20) return 'high';
  if (sampleSize >= 10) return 'medium';
  return 'low';
}

function gradeFor(score: number | null): Pick<AbScoringResult, 'grade' | 'gradeLabel'> {
  if (score == null) return { grade: 'insufficient', gradeLabel: '样本不足' };
  if (score >= 90) return { grade: 'excellent', gradeLabel: '优秀' };
  if (score >= 75) return { grade: 'good', gradeLabel: '良好' };
  if (score >= 60) return { grade: 'pass', gradeLabel: '合格' };
  if (score >= 40) return { grade: 'weak', gradeLabel: '偏弱' };
  return { grade: 'fail', gradeLabel: '不合格' };
}

function fmt(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return String(round(value, digits));
}

export function calculateAbScoring(
  caseStates: Record<string, AbScoringCaseState>,
  options?: { repeatRounds?: number; policy?: AbScoringPolicy; caseIds?: string[] },
): AbScoringResult {
  const policy = options?.policy ?? DEFAULT_AB_SCORING_POLICY;
  const entries = Object.entries(caseStates)
    .filter(([caseId]) => !options?.caseIds || options.caseIds.includes(caseId));
  const pairs = entries.map(([caseId, state]) => ({
    caseId,
    aRuns: flattenRuns(state.a).filter(isTerminal),
    bRuns: flattenRuns(state.b).filter(isTerminal),
  }));
  const completedPairs = pairs.filter(pair => pair.aRuns.length > 0 && pair.bRuns.length > 0);
  const aRuns = completedPairs.flatMap(pair => pair.aRuns);
  const bRuns = completedPairs.flatMap(pair => pair.bRuns);
  const sampleSize = completedPairs.length;
  const repeatRounds = options?.repeatRounds
    ?? Math.max(1, ...completedPairs.map(pair => Math.max(pair.aRuns.length, pair.bRuns.length, 1)));
  const canScore = sampleSize >= policy.minSampleSize;

  // ── 能力分（§3.1）─────────────────────────────────────────
  const evalScoresA = aRuns.map(getEvalScore).filter((v): v is number => v != null);
  const evalScoresB = bRuns.map(getEvalScore).filter((v): v is number => v != null);
  const avgEvalA = avg(evalScoresA);
  const avgEvalB = avg(evalScoresB);
  const deltaScore = avgEvalA == null || avgEvalB == null ? null : avgEvalB - avgEvalA;
  const sCapability = capabilityScore(deltaScore, policy);

  // 数据质量自检：两侧均分同时极低（数据集过难）或同时极高（数据集过简）时,
  // Δscore 失去区分意义,标记 data-quality 不出能力结论。
  const capabilityDataQuality = avgEvalA != null && avgEvalB != null
    ? (avgEvalA < policy.capabilityDataQualityLowMax && avgEvalB < policy.capabilityDataQualityLowMax
        ? `A/B 评测均分同为 < ${policy.capabilityDataQualityLowMax}，数据集可能过难`
        : avgEvalA > policy.capabilityDataQualityHighMin && avgEvalB > policy.capabilityDataQualityHighMin
          ? `A/B 评测均分同为 > ${policy.capabilityDataQualityHighMin}，数据集可能过易，区分度不足`
          : undefined)
    : undefined;

  const capabilityVerdict: AbDimensionVerdict = !canScore
    ? 'insufficient'
    : sCapability == null
      ? 'unavailable'
      : capabilityDataQuality
        ? 'data-quality'
        : sCapability >= policy.capabilityGoodThreshold
          ? 'good'
          : sCapability < policy.capabilityRejectThreshold
            ? 'reject'
            : 'warning';

  const passRateA = passRate(aRuns);
  const passRateB = passRate(bRuns);
  const deltaCapabilityPp = passRateA == null || passRateB == null ? null : (passRateB - passRateA) * 100;

  const capabilityBreakdown: AbScoreBreakdown = {
    formula: `clamp(${policy.capabilityScoreNeutral} + Δscore × ${policy.capabilityScoreSlope}, 0, 100)`,
    steps: [
      `avgEvalA = mean(${evalScoresA.length} runs) = ${fmt(avgEvalA)}`,
      `avgEvalB = mean(${evalScoresB.length} runs) = ${fmt(avgEvalB)}`,
      `Δscore   = avgEvalB − avgEvalA = ${fmt(deltaScore)}`,
      `score    = clamp(${policy.capabilityScoreNeutral} + ${fmt(deltaScore)} × ${policy.capabilityScoreSlope}, 0, 100) = ${fmt(sCapability)}`,
    ],
    reference: 'docs/skill-ab-scoring.md §3.1',
  };

  // ── 成本分（§4.1）─────────────────────────────────────────
  const tokenValuesA = aRuns.map(run => run.tokenUsage).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const tokenValuesB = bRuns.map(run => run.tokenUsage).filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const avgTokensA = avg(tokenValuesA);
  const avgTokensB = avg(tokenValuesB);
  const deltaToken = deltaPct(avgTokensA, avgTokensB);
  const avgDurationA = avg(aRuns.map(run => parseSeconds(run.timeCost)).filter((v): v is number => v != null));
  const avgDurationB = avg(bRuns.map(run => parseSeconds(run.timeCost)).filter((v): v is number => v != null));
  const deltaDuration = deltaPct(avgDurationA, avgDurationB);
  const avgStepsA = avg(aRuns.map(run => run.toolCallCount).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  const avgStepsB = avg(bRuns.map(run => run.toolCallCount).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)));
  const deltaSteps = deltaPct(avgStepsA, avgStepsB);

  const baseCost = baseCostScore(deltaToken, policy);
  const sCost = baseCost == null ? null : applyCostCoupling(baseCost, sCapability, policy);

  const costDataQuality = avgTokensA == null
    ? 'A 组平均 Token 缺失或为 0，成本维度无法计算'
    : undefined;

  const costVerdict: AbDimensionVerdict = !canScore
    ? 'insufficient'
    : sCost == null
      ? 'unavailable'
      : sCost >= policy.costGoodThreshold
        ? 'good'
        : sCost < policy.costRejectThreshold
          ? 'reject'
          : 'warning';

  // 耦合带说明,让用户看出 "+15/−20" 是怎么触发的
  const couplingNote = sCapability == null
    ? '无能力分参考'
    : sCapability >= policy.capabilityGoodThreshold
      ? `能力 ${fmt(sCapability)} ≥ ${policy.capabilityGoodThreshold} → +${policy.costCouplingBonus}`
      : sCapability < policy.capabilityRejectThreshold
        ? `能力 ${fmt(sCapability)} < ${policy.capabilityRejectThreshold} → −${policy.costCouplingPenalty}`
        : `能力 ${fmt(sCapability)} 居中 → ±0`;

  const costBreakdown: AbScoreBreakdown = {
    formula: `baseCost(Δtoken) + couplingByCapability`,
    steps: [
      `avgTokensA = mean(${tokenValuesA.length} runs) = ${fmt(avgTokensA, 0)}`,
      `avgTokensB = mean(${tokenValuesB.length} runs) = ${fmt(avgTokensB, 0)}`,
      `Δtoken     = (avgTokensB − avgTokensA) / avgTokensA × 100% = ${fmt(deltaToken)}%`,
      `baseCost   = piecewise(Δtoken; 0%→100, ${policy.costGoodPct}%→80, ${policy.costWarningPct}%→40, ${policy.costRejectPct}%→0) = ${fmt(baseCost)}`,
      `coupling   = ${couplingNote}`,
      `score      = clamp(baseCost + coupling, 0, 100) = ${fmt(sCost)}`,
    ],
    reference: 'docs/skill-ab-scoring.md §4.1',
  };

  // ── 稳定性分（§5.1）───────────────────────────────────────
  const invokeRate = bRuns.length > 0 ? bRuns.filter(run => run.skillTriggered).length / bRuns.length : null;
  // per-case 方差: 每个 case 的 B 组多轮 pass(0/1) 序列各算一个方差,再求均值。
  const perCaseVariances = completedPairs
    .map(pair => variance(pair.bRuns.map(isPassed).filter((v): v is boolean => v != null).map(v => (v ? 1 : 0))))
    .filter((v): v is number => v != null);
  const avgVariance = perCaseVariances.length > 0 ? avg(perCaseVariances) : null;
  const varianceComputable = avgVariance != null;
  // 重复轮次不足时按 variance=0 处理（一致性系数=1），与规范 §5.4 对齐。
  const effectiveVariance = avgVariance ?? 0;
  const consistencyCoeff = clamp(1 - effectiveVariance / policy.varianceMax, 0, 1);
  const sStability = invokeRate == null ? null : clamp(invokeRate * 100 * consistencyCoeff, 0, 100);
  // 子指标分仅用于 UI 拆解展示,不参与判定。
  const invokeScore = invokeRate == null ? null : clamp(invokeRate * 100, 0, 100);
  const varianceScore = avgVariance == null ? null : clamp(consistencyCoeff * 100, 0, 100);

  const stabilityVerdict: AbDimensionVerdict = !canScore
    ? 'insufficient'
    : sStability == null
      ? 'unavailable'
      : sStability >= policy.stabilityGoodThreshold
        ? 'good'
        : sStability < policy.stabilityRejectThreshold
          ? (invokeRate != null && invokeRate * 100 < policy.stabilityRejectThreshold ? 'revise-description' : 'unreliable')
          : 'warning';

  const stabilityBreakdown: AbScoreBreakdown = {
    formula: `invokeRate × 100 × (1 − variance / ${policy.varianceMax})`,
    steps: [
      `invokeRate = ${bRuns.length > 0 ? bRuns.filter(r => r.skillTriggered).length : 0} / ${bRuns.length} = ${fmt(invokeRate == null ? null : invokeRate * 100)}%`,
      varianceComputable
        ? `variance   = mean(per-case binary variance, ${perCaseVariances.length} cases) = ${fmt(avgVariance, 3)}`
        : `variance   = (重复轮次 < 2，按 0 处理)`,
      `1 − var/${policy.varianceMax} = ${fmt(consistencyCoeff, 3)}`,
      `score      = ${fmt(invokeRate == null ? null : invokeRate * 100)}% × ${fmt(consistencyCoeff, 3)} = ${fmt(sStability)}`,
    ],
    reference: 'docs/skill-ab-scoring.md §5.1',
  };

  // ── 综合判定（§6）─────────────────────────────────────────
  // 短板原则: total = min(cap, cost, stab)。任一维度为 null 都不能出综合分。
  const dims = [sCapability, sCost, sStability];
  const allDimsAvailable = dims.every(d => d != null);
  const totalScore = canScore && allDimsAvailable
    ? Math.round(Math.min(sCapability!, sCost!, sStability!))
    : null;

  // 四道关卡: 样本不足 → 拒绝 → 全好 → 监控发布
  const hardGates: AbScoringResult['hardGates'] = [];
  if (sCapability != null && sCapability < policy.capabilityRejectThreshold) {
    hardGates.push({ key: 'capability', label: `能力分 ${fmt(sCapability)} < ${policy.capabilityRejectThreshold}` });
  }
  if (sCost != null && sCost < policy.costRejectThreshold) {
    hardGates.push({ key: 'cost', label: `成本分 ${fmt(sCost)} < ${policy.costRejectThreshold}` });
  }
  if (sStability != null && sStability < policy.stabilityRejectThreshold) {
    hardGates.push({ key: 'stability', label: `稳定性分 ${fmt(sStability)} < ${policy.stabilityRejectThreshold}` });
  }
  const rejectCategory: AbScoringResult['rejectCategory'] = hardGates[0]?.key ?? null;

  const allGood = sCapability != null && sCost != null && sStability != null
    && sCapability >= policy.capabilityGoodThreshold
    && sCost >= policy.costGoodThreshold
    && sStability >= policy.stabilityGoodThreshold;

  const decision: AbDecision = !canScore
    ? 'insufficient'
    : rejectCategory
      ? 'reject'
      : allGood
        ? 'direct-release'
        : 'monitor-release';

  const totalBreakdown: AbScoreBreakdown = {
    formula: 'min(capability, cost, stability)',
    steps: [
      `capability = ${fmt(sCapability)}`,
      `cost       = ${fmt(sCost)}`,
      `stability  = ${fmt(sStability)}`,
      allDimsAvailable
        ? `total      = min(...) = ${fmt(totalScore, 0)}`
        : `total      = 任一维度缺失，无法出综合分`,
    ],
    reference: 'docs/skill-ab-scoring.md §6.1',
  };

  const grade = gradeFor(totalScore);

  return {
    policyVersion: policy.version,
    sampleSize,
    completedPairs: sampleSize,
    repeatRounds,
    confidence: confidence(sampleSize),
    canScore,
    totalScore,
    totalScoreBreakdown: totalBreakdown,
    ...grade,
    decision,
    decisionLabel: decision === 'insufficient'
      ? '样本不足'
      : decision === 'reject'
        ? rejectCategory === 'capability'
          ? '打回(能力)'
          : rejectCategory === 'cost'
            ? '打回(成本)'
            : '打回(稳定性)'
        : decision === 'direct-release'
          ? '直接发布'
          : '监控发布',
    allowRelease: decision === 'direct-release' || decision === 'monitor-release',
    rejectCategory,
    hardGates,
    capability: {
      avgEvalScoreA: avgEvalA == null ? null : round(avgEvalA, 1),
      avgEvalScoreB: avgEvalB == null ? null : round(avgEvalB, 1),
      deltaScore: deltaScore == null ? null : round(deltaScore, 1),
      passRateA: passRateA == null ? null : round(passRateA * 100, 1),
      passRateB: passRateB == null ? null : round(passRateB * 100, 1),
      deltaPp: deltaCapabilityPp == null ? null : round(deltaCapabilityPp, 1),
      score: sCapability == null ? null : round(sCapability, 1),
      verdict: capabilityVerdict,
      label: capabilityVerdict === 'good' ? '好'
        : capabilityVerdict === 'reject' ? '拒绝'
        : capabilityVerdict === 'data-quality' ? '数据质量问题'
        : capabilityVerdict === 'insufficient' ? '样本不足'
        : capabilityVerdict === 'unavailable' ? '无法计算'
        : '一般',
      tone: capabilityVerdict === 'good' ? 'green'
        : capabilityVerdict === 'reject' ? 'red'
        : capabilityVerdict === 'insufficient' || capabilityVerdict === 'unavailable' ? 'gray'
        : 'amber',
      dataQualityIssue: capabilityDataQuality,
      breakdown: capabilityBreakdown,
    },
    cost: {
      avgTokensA: avgTokensA == null ? null : Math.round(avgTokensA),
      avgTokensB: avgTokensB == null ? null : Math.round(avgTokensB),
      deltaTokenPct: deltaToken == null ? null : round(deltaToken, 1),
      avgDurationA: avgDurationA == null ? null : round(avgDurationA, 1),
      avgDurationB: avgDurationB == null ? null : round(avgDurationB, 1),
      deltaDurationPct: deltaDuration == null ? null : round(deltaDuration, 1),
      avgStepsA: avgStepsA == null ? null : round(avgStepsA, 1),
      avgStepsB: avgStepsB == null ? null : round(avgStepsB, 1),
      deltaStepsPct: deltaSteps == null ? null : round(deltaSteps, 1),
      baseCost: baseCost == null ? null : round(baseCost, 1),
      score: sCost == null ? null : round(sCost, 1),
      verdict: costVerdict,
      label: costVerdict === 'good' ? '好'
        : costVerdict === 'reject' ? '拒绝'
        : costVerdict === 'insufficient' ? '样本不足'
        : costVerdict === 'unavailable' ? '无法计算'
        : '警告',
      tone: costVerdict === 'good' ? 'green'
        : costVerdict === 'reject' ? 'red'
        : costVerdict === 'insufficient' || costVerdict === 'unavailable' ? 'gray'
        : 'amber',
      dataQualityIssue: costDataQuality,
      breakdown: costBreakdown,
    },
    stability: {
      invokeRate: invokeRate == null ? null : round(invokeRate * 100, 1),
      variance: avgVariance == null ? null : round(avgVariance, 3),
      score: sStability == null ? null : round(sStability, 1),
      invokeScore: invokeScore == null ? null : round(invokeScore, 1),
      varianceScore: varianceScore == null ? null : round(varianceScore, 1),
      verdict: stabilityVerdict,
      label: stabilityVerdict === 'good' ? '好'
        : stabilityVerdict === 'revise-description' ? '改描述'
        : stabilityVerdict === 'unreliable' ? '不可靠'
        : stabilityVerdict === 'insufficient' ? '样本不足'
        : stabilityVerdict === 'unavailable' ? '无法计算'
        : '警告',
      tone: stabilityVerdict === 'good' ? 'green'
        : stabilityVerdict === 'revise-description' || stabilityVerdict === 'unreliable' ? 'red'
        : stabilityVerdict === 'insufficient' || stabilityVerdict === 'unavailable' ? 'gray'
        : 'amber',
      varianceComputable,
      dataQualityIssue: varianceComputable ? undefined : '重复轮次不足，方差不可计算',
      breakdown: stabilityBreakdown,
    },
  };
}
