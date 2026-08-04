/**
 * 实验侧结果评测预置评估器：把可靠性与性能页的四个「结果评测」分析能力
 *   preset-result-accuracy    结果准确性（依赖参考数据）
 *   preset-result-answer      答案质量
 *   preset-result-faithfulness 忠实度（幻觉检测）
 *   preset-result-instruction 指令遵循
 * 抽取进实验统一契约。四个评估器共用同一 canonical 能力（runSingleResultMetric）与
 * 同一直连传输（createResultInvoke，seed=42/temp=0/严格 schema）。
 *
 * 依赖 result-metric-evaluator（server-only：openai/model config），故惰性 import，
 * 与 faithful-preset-evaluators 同策略——测试注入时零加载。
 */
import { normalizeEvaluatorOutput, type EvaluatorOutput, type EvalPoint, type EvalPointStatus } from '../../evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';

export const RESULT_PRESET_IDS = [
  'preset-result-accuracy',
  'preset-result-answer',
  'preset-result-faithfulness',
  'preset-result-instruction',
] as const;
export type ResultPresetId = (typeof RESULT_PRESET_IDS)[number];

export function isResultPresetId(id: string): id is ResultPresetId {
  return (RESULT_PRESET_IDS as readonly string[]).includes(id);
}

/** 测试注入点（同 faithful/judge-llm）：跳过真实 LLM 调用直接返回。 */
type ResultRunner = (id: ResultPresetId, user: string, ctx: FaithfulPresetContext) => Promise<EvaluatorOutput>;
let testRunner: ResultRunner | null = null;
export function setResultPresetRunnerForTest(fn: ResultRunner | null): void {
  testRunner = fn;
}

const ID_TO_METRIC: Record<ResultPresetId, 'accuracy' | 'answer-quality' | 'faithfulness' | 'instruction-adherence'> = {
  'preset-result-accuracy': 'accuracy',
  'preset-result-answer': 'answer-quality',
  'preset-result-faithfulness': 'faithfulness',
  'preset-result-instruction': 'instruction-adherence',
};

export async function runResultPreset(
  id: ResultPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  if (testRunner) return testRunner(id, user, ctx);

  const {
    createResultInvoke, runSingleResultMetric, extractRelevantSystemInstructions,
  } = await import('../evaluation/result-metric-evaluator');

  const invoke = await createResultInvoke(user);
  const metric = ID_TO_METRIC[id];
  const query = ctx.caseInput;
  const finalResult = ctx.actualOutput;

  if (metric === 'accuracy') {
    // GT 来源：实验直接用 referenceOutput（可靠性页走数据集匹配，此处不同源同评估器）。
    const expectedOutput = (ctx.referenceOutput ?? '').trim();
    if (!expectedOutput) {
      // 依赖参考数据但未标注——④ 步门控应已拦截，此处兜底为无分。
      return {
        summary: '未标注参考答案，无法评估结果准确性——不记分。',
        evidence: { md: '未标注参考答案，无法评估结果准确性——不记分。' },
      };
    }
    // 主张从实际输出抽（与忠实度共用同一批 claim），逐条对参考答案判对错——精确率口径
    const r = await runSingleResultMetric('accuracy', { query, finalResult, expectedOutput }, invoke);
    return mapAccuracy(r);
  }

  if (metric === 'faithfulness') {
    const r = await runSingleResultMetric('faithfulness', { query, finalResult, interactions: ctx.interactions }, invoke);
    return mapFaithfulness(r);
  }

  if (metric === 'instruction-adherence') {
    const systems = extractRelevantSystemInstructions(ctx.interactions);
    const r = await runSingleResultMetric('instruction-adherence', { query, finalResult, relevantSystemInstructions: systems }, invoke);
    return mapInstruction(r);
  }

  // answer-quality
  const r = await runSingleResultMetric('answer-quality', { query, finalResult }, invoke);
  return mapAnswerQuality(r);
}

// ── 各指标 evidence → 统一契约 points 的映射 ──────────────────────────────────

interface LeafResult { score: number | null; evidence: Record<string, unknown>; note?: string }

const asArr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : [];
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const joinMd = (...parts: unknown[]) => parts.map(str).filter((s) => s.trim()).join('\n');

/** 准确性：claimFindings → points（实际输出的每条主张 × 对参考答案的判定，说错的直接 0 分拉低均分） */
function mapAccuracy(r: LeafResult): EvaluatorOutput {
  const findings = asArr(r.evidence.claimFindings);
  const statusMap: Record<string, EvalPointStatus | undefined> = {
    correct: 'covered', partially_correct: 'partial', wrong: 'missing',
    // not_in_reference：参考未涉及、不计入分母 —— 不给状态 chip，靠证据文字说明
  };
  const statusText: Record<string, string> = {
    correct: '与参考一致', partially_correct: '部分一致', wrong: '与参考冲突',
    not_in_reference: '参考答案未涉及此主张——不计入准确性分母',
  };
  const points: EvalPoint[] = findings.map((f) => {
    const pt: EvalPoint = { label: str(f.claim).slice(0, 120) || '主张' };
    // finding.score 为 0-1 量纲，契约要 0-100 → ×100（null=参考未涉及，不给分）
    if (typeof f.score === 'number') pt.score = Math.round(f.score * 1000) / 10;
    const st = statusMap[str(f.status)];
    if (st) pt.status = st;
    const md = joinMd(
      statusText[str(f.status)],
      f.reason,
      f.sourceQuote && `实际输出原文：${str(f.sourceQuote)}`,
      f.expectedEvidence && `参考依据：${str(f.expectedEvidence)}`,
    );
    if (md) pt.evidence = { md };
    return pt;
  }).filter((p) => p.label);
  return normalizeEvaluatorOutput({ summary: str(r.evidence.reason), score: r.score ?? undefined, points: points.length ? points : undefined, evidence: r.evidence.reason ? { md: str(r.evidence.reason) } : undefined });
}

/** 答案质量：relevance/completeness/coherence 三子分 → points */
function mapAnswerQuality(r: LeafResult): EvaluatorOutput {
  const sub = (r.evidence.subScores ?? {}) as Record<string, unknown>;
  const rel = (r.evidence.relevance ?? {}) as Record<string, unknown>;
  const comp = (r.evidence.completeness ?? {}) as Record<string, unknown>;
  const coh = (r.evidence.coherence ?? {}) as Record<string, unknown>;
  const cohChecks = (coh.checks ?? {}) as Record<string, unknown>;
  const countBy = (rows: Record<string, unknown>[], key: string, val: string) =>
    rows.filter((x) => str(x[key]) === val).length;

  // 逐维度把底层判定汇总成证据 md——否则三个子项「有分无据」，用户无法核验
  const relVerdicts = asArr(rel.verdicts);
  const relMd = relVerdicts.length
    ? joinMd(
        `${relVerdicts.length} 条陈述：相关 ${countBy(relVerdicts, 'verdict', 'relevant')}、间接支撑 ${countBy(relVerdicts, 'verdict', 'supporting')}、无关 ${countBy(relVerdicts, 'verdict', 'irrelevant')}`,
        relVerdicts.filter((v) => str(v.verdict) === 'irrelevant')
          .map((v) => `- 无关：${str(v.reason) || str(v.statement) || str(v.statementId)}`).join('\n'),
      )
    : '';

  const compVerdicts = asArr(comp.verdicts);
  const compMd = compVerdicts.length
    ? joinMd(
        `${compVerdicts.length} 项必答要点：覆盖 ${countBy(compVerdicts, 'status', 'covered')}、部分 ${countBy(compVerdicts, 'status', 'partial')}、缺失 ${countBy(compVerdicts, 'status', 'missing')}`,
        compVerdicts.filter((v) => str(v.status) !== 'covered')
          .map((v) => `- ${str(v.status) === 'partial' ? '部分' : '缺失'}：${str(v.reason) || str(v.requirementId)}`).join('\n'),
      )
    : '';

  const cohMd = joinMd(
    typeof coh.rating === 'number' ? `连贯性评级 ${coh.rating}/4` : '',
    str(coh.reason),
    [
      ...asArr(cohChecks.contradictions).map((x) => `- 矛盾：${str(x.quote)}`),
      ...asArr(cohChecks.repetitions).map((x) => `- 重复：${str(x.quote)}`),
      ...asArr(cohChecks.abruptTransitions).map((x) => `- 跳跃：${str(x.quote)}`),
    ].join('\n'),
  );

  const mdByKey: Record<string, string> = { relevance: relMd, completeness: compMd, coherence: cohMd };
  const dims: Array<[string, string]> = [['relevance', '相关性'], ['completeness', '完整性'], ['coherence', '连贯性']];
  const points: EvalPoint[] = dims
    .filter(([k]) => typeof sub[k] === 'number')
    .map(([k, label]) => {
      const pt: EvalPoint = { label, score: sub[k] as number };
      if (mdByKey[k]) pt.evidence = { md: mdByKey[k] };
      return pt;
    });
  return normalizeEvaluatorOutput({ summary: str(r.evidence.reason), score: r.score ?? undefined, points: points.length ? points : undefined, evidence: r.evidence.reason ? { md: str(r.evidence.reason) } : undefined });
}

/** 忠实度：claims/verdicts → points（逐条主张对 trace 证据判有无依据；无依据即 0 分拉低均分） */
function mapFaithfulness(r: LeafResult): EvaluatorOutput {
  const claims = asArr(r.evidence.verdicts).length ? asArr(r.evidence.verdicts) : asArr(r.evidence.claims);
  const statusMap: Record<string, EvalPointStatus | undefined> = { supported: 'covered', contradicted: 'missing', not_covered: 'missing' };
  // 单点分与卡片总分同源：总分 = 有依据数/主张总数，等价于此处逐点 100/0 的平均
  const scoreMap: Record<string, number | undefined> = { supported: 100, contradicted: 0, not_covered: 0 };
  const statusText: Record<string, string> = {
    supported: '有工具证据支持', contradicted: '与工具证据矛盾', not_covered: '工具证据未覆盖此主张',
  };
  const points: EvalPoint[] = claims.map((c) => {
    const pt: EvalPoint = { label: (str(c.claim) || str(c.sourceQuote) || '主张').slice(0, 120) };
    const st = statusMap[str(c.status)];
    if (st) pt.status = st;
    const sc = scoreMap[str(c.status)];
    if (typeof sc === 'number') pt.score = sc;
    const cites = asArr(c.citations).map((ci) => str(ci.evidenceQuote)).filter(Boolean);
    const md = joinMd(statusText[str(c.status)], c.reason, cites.length && `证据：${cites.join('；')}`);
    if (md) pt.evidence = { md };
    return pt;
  }).filter((p) => p.label);
  return normalizeEvaluatorOutput({ summary: str(r.evidence.reason), score: r.score ?? undefined, points: points.length ? points : undefined, evidence: r.evidence.reason ? { md: str(r.evidence.reason) } : undefined });
}

/** 指令遵循：verdicts → points（met/not_met/not_applicable → 状态；not_applicable 略去） */
function mapInstruction(r: LeafResult): EvaluatorOutput {
  const verdicts = asArr(r.evidence.verdicts);
  const constraints = asArr(r.evidence.constraints);
  const cById = new Map(constraints.map((c) => [str(c.id), str(c.text)]));
  const statusMap: Record<string, EvalPointStatus | undefined> = { met: 'covered', not_met: 'missing' };
  const points: EvalPoint[] = verdicts
    .filter((v) => str(v.status) !== 'not_applicable')
    .map((v) => {
      const label = (cById.get(str(v.constraintId)) || str(v.constraintId) || '约束').slice(0, 120);
      const pt: EvalPoint = { label };
      const st = statusMap[str(v.status)];
      if (st) pt.status = st;
      const md = joinMd(v.reason, v.evidenceQuote && `引用：${str(v.evidenceQuote)}`);
      if (md) pt.evidence = { md };
      return pt;
    });
  return normalizeEvaluatorOutput({ summary: str(r.evidence.reason), score: r.score ?? undefined, points: points.length ? points : undefined, evidence: r.evidence.reason ? { md: str(r.evidence.reason) } : undefined });
}
