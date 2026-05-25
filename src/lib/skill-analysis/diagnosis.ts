export type DiagnosisMode = 'llm' | 'fallback';
export type DiagnosisDimensionStatus = 'unconfigured' | 'pending' | 'running' | 'done' | 'failed';
export type DiagnosisDimensionKey = 'ab' | 'trace' | 'recall' | 'static';

export interface SkillDiagnosisSnapshot {
  skillName: string;
  version: number | null;
  overall: {
    weightedScore: number | null;
    coveredCount: number;
    totalCount: number;
    missingDimensions: string[];
    selectedDimensionsThisRun: DiagnosisDimensionKey[];
  };
  ab: {
    configured: boolean;
    hasResult: boolean;
    status: DiagnosisDimensionStatus;
    scoreA: number | null;
    scoreB: number | null;
    finalScore?: number | null;
    decisionLabel?: string | null;
    capabilityDeltaPp?: number | null;
    tokenDeltaPct?: number | null;
    invokeRate?: number | null;
    variance?: number | null;
    delta: number | null;
    pValue: number | null;
    sampleCount: number | null;
    recommendation: 'up' | 'down' | 'flat' | 'insufficient' | null;
  };
  trace: {
    configured: boolean;
    hasResult: boolean;
    status: DiagnosisDimensionStatus;
    score: number | null;
    fullyEvaluatedCount: number;
    totalTraceCount: number;
    highDeviationCount: number;
  };
  recall: {
    configured: boolean;
    hasResult: boolean;
    status: DiagnosisDimensionStatus;
    score: number | null;
    passRate: number | null;
    truePositiveRate: number | null;
    falsePositiveRate: number | null;
    itemCount: number;
    positiveCount: number;
  };
  static: {
    configured: boolean;
    hasResult: boolean;
    status: DiagnosisDimensionStatus;
    score: number | null;
    passedCount: number;
    totalCount: number;
    issueCount: number;
  };
}

export interface SkillDiagnosisResult {
  problem: string;
  suggestion: string;
  mode: DiagnosisMode;
  modelLabel?: string | null;
  errorMessage?: string | null;
}

const DIMENSION_LABELS: Record<DiagnosisDimensionKey, string> = {
  ab: 'A/B 测试',
  trace: '用例分析',
  recall: '召回分析',
  static: '静态合规',
};

function hasAbRegression(snapshot: SkillDiagnosisSnapshot) {
  return (snapshot.ab.delta ?? 0) < 0 && (snapshot.ab.pValue ?? 1) < 0.05;
}

function getMissingDimensionLabels(snapshot: SkillDiagnosisSnapshot) {
  return snapshot.overall.missingDimensions
    .map((key) => DIMENSION_LABELS[key as DiagnosisDimensionKey])
    .filter(Boolean);
}

function getLowestCompletedDimension(snapshot: SkillDiagnosisSnapshot) {
  const scores: Array<{ key: DiagnosisDimensionKey; label: string; score: number }> = [];
  if (snapshot.ab.hasResult && snapshot.ab.scoreB != null) scores.push({ key: 'ab', label: DIMENSION_LABELS.ab, score: snapshot.ab.scoreB });
  if (snapshot.trace.hasResult && snapshot.trace.score != null) scores.push({ key: 'trace', label: DIMENSION_LABELS.trace, score: snapshot.trace.score });
  if (snapshot.recall.hasResult && snapshot.recall.score != null) scores.push({ key: 'recall', label: DIMENSION_LABELS.recall, score: snapshot.recall.score });
  if (snapshot.static.hasResult && snapshot.static.score != null) scores.push({ key: 'static', label: DIMENSION_LABELS.static, score: snapshot.static.score });
  scores.sort((a, b) => a.score - b.score);
  return scores[0] || null;
}

export function buildFallbackDiagnosis(snapshot: SkillDiagnosisSnapshot): SkillDiagnosisResult {
  if (hasAbRegression(snapshot)) {
    const delta = snapshot.ab.delta == null ? '' : `（${snapshot.ab.delta > 0 ? '+' : ''}${snapshot.ab.delta} 分）`;
    return {
      problem: `A/B 测试显示启用 Skill 后结果显著回退${delta}，当前版本不建议上线。`,
      suggestion: '建议优先排查 A/B 回退原因，再结合低分维度做针对性修正。',
      mode: 'fallback',
    };
  }

  if (snapshot.overall.coveredCount < snapshot.overall.totalCount) {
    const missing = getMissingDimensionLabels(snapshot);
    const missingText = missing.length > 0 ? `，缺少 ${missing.join('、')} 结果` : '';
    return {
      problem: `当前仅有 ${snapshot.overall.coveredCount}/${snapshot.overall.totalCount} 个维度完成评测${missingText}，数据覆盖仍不完整。`,
      suggestion: '建议先补齐可运行维度，再判断是否需要进入 Skill 优化。',
      mode: 'fallback',
    };
  }

  const lowest = getLowestCompletedDimension(snapshot);
  if (!lowest) {
    return {
      problem: '当前还没有足够的评测结果，暂时无法形成稳定诊断。',
      suggestion: '建议先运行至少一个可用维度，再查看诊断与后续优化建议。',
      mode: 'fallback',
    };
  }

  if (lowest.key === 'trace') {
    return {
      problem: `当前主要短板集中在${lowest.label}，已评测 Trace 中有 ${snapshot.trace.highDeviationCount} 条高偏离。`,
      suggestion: '建议优先进入用例分析详情，先处理高偏离 Trace 和低分场景。',
      mode: 'fallback',
    };
  }

  if (lowest.key === 'recall') {
    return {
      problem: `当前主要短板集中在${lowest.label}，触发集通过率仅 ${Math.round(snapshot.recall.passRate ?? 0)}%。`,
      suggestion: '建议优先补强召回触发集与路由边界，再重新验证命中率表现。',
      mode: 'fallback',
    };
  }

  if (lowest.key === 'static') {
    return {
      problem: `当前主要短板集中在${lowest.label}，仍有 ${snapshot.static.issueCount} 项待处理问题。`,
      suggestion: '建议优先修复静态合规问题，再复测整体健康分变化。',
      mode: 'fallback',
    };
  }

  return {
    problem: `当前主要短板集中在${lowest.label}，已成为综合分的主要拖累。`,
    suggestion: '建议优先进入对应详情页，先处理最影响分数的问题。',
    mode: 'fallback',
  };
}

export function buildDiagnosisPrompt(snapshot: SkillDiagnosisSnapshot) {
  const system = [
    '你是 Skill 分析页的一句话诊断生成器。',
    '你的任务是基于四个评估维度的结构化摘要，输出两行中文：',
    '1. problem：指出当前最重要的风险或不足。',
    '2. suggestion：给出下一步最可执行的动作。',
    '要求：',
    '- 只能基于输入 JSON，不要编造信息。',
    '- 优先级：A/B 显著劣化 > 覆盖不足/未配置 > 已完成维度中的最低分项。',
    '- 如果 delta < 0 且 pValue < 0.05，problem 必须明确表达“不建议上线”。',
    '- 如果维度未配置或缺结果，要明确说“数据不足”或“覆盖不完整”。',
    '- suggestion 必须是动作，不要空话。',
    '- 每个字段尽量控制在 20-50 字。',
    '- 输出严格 JSON：{"problem":"...","suggestion":"..."}',
  ].join('\n');

  const user = [
    '请根据以下 Skill 分析快照生成诊断：',
    JSON.stringify(snapshot, null, 2),
  ].join('\n\n');

  return { system, user };
}

export function parseDiagnosisResponse(raw: string): Pick<SkillDiagnosisResult, 'problem' | 'suggestion'> | null {
  let text = (raw || '').trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) text = fenced[1].trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text) as { problem?: unknown; suggestion?: unknown };
    if (typeof parsed.problem !== 'string' || typeof parsed.suggestion !== 'string') return null;
    const problem = parsed.problem.trim();
    const suggestion = parsed.suggestion.trim();
    if (!problem || !suggestion) return null;
    return { problem, suggestion };
  } catch {
    return null;
  }
}
