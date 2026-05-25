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
  minSampleSize: number;
  recommendedSampleSize: number;
  minRepeats: number;
  capabilityGoodThresholdPp: number;
  costGoodThresholdPct: number;
  costWarningThresholdPct: number;
  invokeRateGood: number;
  invokeRateMinimum: number;
  varianceGood: number;
  varianceMax: number;
  weights: {
    capability: number;
    cost: number;
    stability: number;
  };
  stabilityWeights: {
    invoke: number;
    variance: number;
  };
  hardGateCeilings: {
    capability: number;
    cost: number;
    stability: number;
  };
}

export interface AbScoringResult {
  policyVersion: string;
  sampleSize: number;
  completedPairs: number;
  repeatRounds: number;
  confidence: 'low' | 'medium' | 'high';
  canScore: boolean;
  totalScore: number | null;
  grade: 'excellent' | 'good' | 'pass' | 'weak' | 'fail' | 'insufficient';
  gradeLabel: string;
  decision: AbDecision;
  decisionLabel: string;
  allowRelease: boolean;
  rejectCategory: 'capability' | 'cost' | 'stability' | null;
  hardGates: Array<{ key: string; ceiling: number; label: string }>;
  capability: {
    passRateA: number | null;
    passRateB: number | null;
    deltaPp: number | null;
    score: number | null;
    verdict: AbDimensionVerdict;
    label: string;
    tone: AbTone;
    dataQualityIssue?: string;
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
    score: number | null;
    verdict: AbDimensionVerdict;
    label: string;
    tone: AbTone;
    dataQualityIssue?: string;
  };
  stability: {
    invokeRate: number | null;
    variance: number | null;
    score: number | null;
    invokeScore: number | null;
    varianceScore: number | null;
    verdict: AbDimensionVerdict;
    label: string;
    tone: AbTone;
    varianceComputable: boolean;
    dataQualityIssue?: string;
  };
}

export const DEFAULT_AB_SCORING_POLICY: AbScoringPolicy = {
  version: 'agent-skill-scoring-v2.2',
  minSampleSize: 1,
  recommendedSampleSize: 20,
  minRepeats: 1,
  capabilityGoodThresholdPp: 10,
  costGoodThresholdPct: 20,
  costWarningThresholdPct: 100,
  invokeRateGood: 0.9,
  invokeRateMinimum: 0.7,
  varianceGood: 0.1,
  varianceMax: 0.25,
  weights: {
    capability: 0.5,
    cost: 0.25,
    stability: 0.25,
  },
  stabilityWeights: {
    invoke: 0.6,
    variance: 0.4,
  },
  hardGateCeilings: {
    capability: 30,
    cost: 30,
    stability: 35,
  },
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

function isPassed(run: AbScoringRun): boolean | null {
  if (typeof run.score === 'number' && Number.isFinite(run.score)) return run.score >= 60;
  if (typeof run.pass === 'number' && Number.isFinite(run.pass)) return run.pass >= 60;
  if (run.status === 'pass') return true;
  if (run.status === 'fail') return false;
  return null;
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

function capabilityScore(deltaPp: number | null): number | null {
  if (deltaPp == null) return null;
  if (deltaPp < 0) return 0;
  if (deltaPp < 10) return 60 + (deltaPp / 10) * 20;
  if (deltaPp < 30) return 80 + ((deltaPp - 10) / 20) * 20;
  return 100;
}

function costScore(deltaTokenPct: number | null): number | null {
  if (deltaTokenPct == null) return null;
  if (deltaTokenPct <= 0) return 100;
  if (deltaTokenPct <= 20) return 80 + (1 - deltaTokenPct / 20) * 20;
  if (deltaTokenPct <= 100) return 40 + (1 - (deltaTokenPct - 20) / 80) * 40;
  return Math.max(0, 40 - (deltaTokenPct - 100) / 5);
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
  const repeatRounds = options?.repeatRounds ?? Math.max(1, ...completedPairs.map(pair => Math.max(pair.aRuns.length, pair.bRuns.length, 1)));
  const canScore = sampleSize >= policy.minSampleSize;

  const passRateA = passRate(aRuns);
  const passRateB = passRate(bRuns);
  const deltaCapabilityPp = passRateA == null || passRateB == null ? null : (passRateB - passRateA) * 100;
  const sCapability = capabilityScore(deltaCapabilityPp);
  const capabilityDataQuality = passRateA === 0 && passRateB === 0
    ? 'A/B 通过率同为 0%，数据集可能过难'
    : passRateA === 1 && passRateB === 1
      ? 'A/B 通过率同为 100%，数据集可能过易'
      : undefined;
  const capabilityVerdict: AbDimensionVerdict = !canScore
    ? 'insufficient'
    : deltaCapabilityPp == null
      ? 'unavailable'
      : capabilityDataQuality
        ? 'data-quality'
        : deltaCapabilityPp < 0
          ? 'reject'
          : deltaCapabilityPp >= policy.capabilityGoodThresholdPp
            ? 'good'
            : 'warning';

  const avgTokensA = avg(aRuns.map(run => run.tokenUsage).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0));
  const avgTokensB = avg(bRuns.map(run => run.tokenUsage).filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0));
  const deltaToken = deltaPct(avgTokensA, avgTokensB);
  const avgDurationA = avg(aRuns.map(run => parseSeconds(run.timeCost)).filter((value): value is number => value != null));
  const avgDurationB = avg(bRuns.map(run => parseSeconds(run.timeCost)).filter((value): value is number => value != null));
  const deltaDuration = deltaPct(avgDurationA, avgDurationB);
  const avgStepsA = avg(aRuns.map(run => run.toolCallCount).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
  const avgStepsB = avg(bRuns.map(run => run.toolCallCount).filter((value): value is number => typeof value === 'number' && Number.isFinite(value)));
  const deltaSteps = deltaPct(avgStepsA, avgStepsB);
  const sCost = costScore(deltaToken);
  const costDataQuality = avgTokensA == null
    ? 'A 组平均 Token 缺失或为 0，成本维度无法计算'
    : undefined;
  const costVerdict: AbDimensionVerdict = !canScore
    ? 'insufficient'
    : deltaToken == null
      ? 'unavailable'
      : deltaToken <= policy.costGoodThresholdPct
        ? 'good'
        : deltaToken > policy.costWarningThresholdPct && (deltaCapabilityPp ?? Number.NEGATIVE_INFINITY) < policy.capabilityGoodThresholdPp
          ? 'reject'
          : 'warning';

  const invokeRate = bRuns.length > 0 ? bRuns.filter(run => run.skillTriggered).length / bRuns.length : null;
  const perCaseVariances = completedPairs
    .map(pair => variance(pair.bRuns.map(isPassed).filter((value): value is boolean => value != null).map(value => (value ? 1 : 0))))
    .filter((value): value is number => value != null);
  const avgVariance = perCaseVariances.length > 0 ? avg(perCaseVariances) : null;
  const invokeScore = invokeRate == null ? null : clamp(invokeRate * 100, 0, 100);
  const varianceScore = avgVariance == null ? null : clamp((1 - avgVariance / policy.varianceMax) * 100, 0, 100);
  const varianceComputable = avgVariance != null;
  const sStability = invokeScore == null
    ? null
    : varianceScore == null
      ? invokeScore
      : policy.stabilityWeights.invoke * invokeScore + policy.stabilityWeights.variance * varianceScore;
  const stabilityVerdict: AbDimensionVerdict = !canScore
    ? 'insufficient'
    : invokeRate == null
      ? 'unavailable'
      : invokeRate < policy.invokeRateMinimum
        ? 'revise-description'
        : avgVariance != null && avgVariance > policy.varianceMax
          ? 'unreliable'
          : invokeRate >= policy.invokeRateGood && (avgVariance == null || avgVariance <= policy.varianceGood)
            ? 'good'
            : 'warning';

  const rawTotal = sCapability == null || sCost == null || sStability == null
    ? null
    : policy.weights.capability * sCapability
      + policy.weights.cost * sCost
      + policy.weights.stability * sStability;
  const hardGates: AbScoringResult['hardGates'] = [];
  if (deltaCapabilityPp != null && deltaCapabilityPp < 0) {
    hardGates.push({ key: 'capability', ceiling: policy.hardGateCeilings.capability, label: '能力反向' });
  }
  if (deltaToken != null && deltaToken > policy.costWarningThresholdPct && (deltaCapabilityPp ?? Number.NEGATIVE_INFINITY) < policy.capabilityGoodThresholdPp) {
    hardGates.push({ key: 'cost', ceiling: policy.hardGateCeilings.cost, label: '成本过高且能力不足' });
  }
  if (invokeRate != null && invokeRate < policy.invokeRateMinimum) {
    hardGates.push({ key: 'stability', ceiling: policy.hardGateCeilings.stability, label: '触发率低于底线' });
  }
  if (avgVariance != null && avgVariance > policy.varianceMax) {
    hardGates.push({ key: 'stability', ceiling: policy.hardGateCeilings.stability, label: '多轮方差过高' });
  }
  const gatedTotal = canScore && rawTotal != null
    ? Math.round(hardGates.reduce((score, gate) => Math.min(score, gate.ceiling), rawTotal))
    : null;
  const grade = gradeFor(gatedTotal);
  const rejectCategory = hardGates.some(gate => gate.key === 'capability')
    ? 'capability'
    : hardGates.some(gate => gate.key === 'cost')
      ? 'cost'
      : hardGates.some(gate => gate.key === 'stability')
        ? 'stability'
        : null;
  const decision: AbDecision = !canScore
    ? 'insufficient'
    : rejectCategory
      ? 'reject'
      : capabilityVerdict === 'good' && costVerdict === 'good' && stabilityVerdict === 'good'
        ? 'direct-release'
        : 'monitor-release';

  return {
    policyVersion: policy.version,
    sampleSize,
    completedPairs: sampleSize,
    repeatRounds,
    confidence: confidence(sampleSize),
    canScore,
    totalScore: gatedTotal,
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
      passRateA: passRateA == null ? null : round(passRateA * 100, 1),
      passRateB: passRateB == null ? null : round(passRateB * 100, 1),
      deltaPp: deltaCapabilityPp == null ? null : round(deltaCapabilityPp, 1),
      score: sCapability == null ? null : round(sCapability, 1),
      verdict: capabilityVerdict,
      label: capabilityVerdict === 'good' ? '好' : capabilityVerdict === 'reject' ? '拒绝' : capabilityVerdict === 'data-quality' ? '数据质量问题' : capabilityVerdict === 'insufficient' ? '样本不足' : '一般',
      tone: capabilityVerdict === 'good' ? 'green' : capabilityVerdict === 'reject' ? 'red' : capabilityVerdict === 'insufficient' ? 'gray' : 'amber',
      dataQualityIssue: capabilityDataQuality,
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
      score: sCost == null ? null : round(sCost, 1),
      verdict: costVerdict,
      label: costVerdict === 'good' ? '好' : costVerdict === 'reject' ? '拒绝' : costVerdict === 'insufficient' ? '样本不足' : costVerdict === 'unavailable' ? '无法计算' : '警告',
      tone: costVerdict === 'good' ? 'green' : costVerdict === 'reject' ? 'red' : costVerdict === 'insufficient' || costVerdict === 'unavailable' ? 'gray' : 'amber',
      dataQualityIssue: costDataQuality,
    },
    stability: {
      invokeRate: invokeRate == null ? null : round(invokeRate * 100, 1),
      variance: avgVariance == null ? null : round(avgVariance, 3),
      score: sStability == null ? null : round(sStability, 1),
      invokeScore: invokeScore == null ? null : round(invokeScore, 1),
      varianceScore: varianceScore == null ? null : round(varianceScore, 1),
      verdict: stabilityVerdict,
      label: stabilityVerdict === 'good' ? '好' : stabilityVerdict === 'revise-description' ? '改描述' : stabilityVerdict === 'unreliable' ? '不可靠' : stabilityVerdict === 'insufficient' ? '样本不足' : stabilityVerdict === 'unavailable' ? '无法计算' : '警告',
      tone: stabilityVerdict === 'good' ? 'green' : stabilityVerdict === 'revise-description' || stabilityVerdict === 'unreliable' ? 'red' : stabilityVerdict === 'insufficient' || stabilityVerdict === 'unavailable' ? 'gray' : 'amber',
      varianceComputable,
      dataQualityIssue: varianceComputable ? undefined : '重复轮次不足，方差不可计算',
    },
  };
}
