import { normalizeEvaluatorOutput, type EvalPoint, type EvalPointStatus, type EvaluatorOutput } from '@/lib/evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import {
  normalizeEntityF1RunConfig,
  normalizeExactMatchRunConfig,
  type EntityF1RunConfig,
  type ExactMatchRunConfig,
} from '@/lib/evaluators/evaluator-run-config';
import { runTextAiFlavorPreset, TEXT_AI_FLAVOR_PRESET_ID } from './text-ai-flavor-preset-evaluator';
import { runTextConcisenessPreset, TEXT_CONCISENESS_PRESET_ID } from './text-conciseness-preset-evaluator';
import { runTextFormatPreset, TEXT_FORMAT_PRESET_ID } from './text-format-preset-evaluator';
import {
  runTextLanguageConsistencyPreset,
  TEXT_LANGUAGE_CONSISTENCY_PRESET_ID,
} from './text-language-consistency-preset-evaluator';

export const TEXT_PRESET_IDS = [
  'preset-text-rouge',
  'preset-text-exact-match',
  'preset-text-entity-f1',
  TEXT_AI_FLAVOR_PRESET_ID,
  TEXT_FORMAT_PRESET_ID,
  TEXT_LANGUAGE_CONSISTENCY_PRESET_ID,
  TEXT_CONCISENESS_PRESET_ID,
] as const;

export type TextPresetId = (typeof TEXT_PRESET_IDS)[number];

type ReferenceTextPresetId = Extract<
  TextPresetId,
  'preset-text-rouge' | 'preset-text-exact-match' | 'preset-text-entity-f1'
>;

export function isTextPresetId(id: string): id is TextPresetId {
  return (TEXT_PRESET_IDS as readonly string[]).includes(id);
}

export function runTextPreset(
  id: TextPresetId,
  user: string,
  ctx: FaithfulPresetContext,
  config?: ExactMatchRunConfig | EntityF1RunConfig,
): Promise<EvaluatorOutput> {
  switch (id) {
    case TEXT_AI_FLAVOR_PRESET_ID: return runTextAiFlavorPreset(user, ctx);
    case TEXT_FORMAT_PRESET_ID: return runTextFormatPreset(user, ctx);
    case TEXT_LANGUAGE_CONSISTENCY_PRESET_ID: return runTextLanguageConsistencyPreset(user, ctx);
    case TEXT_CONCISENESS_PRESET_ID: return runTextConcisenessPreset(user, ctx);
  }
  return runReferenceTextPreset(id, ctx, config);
}

export class EntityListParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EntityListParseError';
  }
}

export function parseEntityList(text: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EntityListParseError('实体列表必须是有效的 JSON 字符串数组');
  }
  if (!Array.isArray(parsed) || parsed.some((entity) => typeof entity !== 'string')) {
    throw new EntityListParseError('实体列表必须是 JSON 字符串数组，例如 ["北京", "上海"]');
  }
  return parsed;
}

function to100(value: number): number {
  return Math.round(value * 1000) / 10;
}

function statusOf(score: number): EvalPointStatus {
  if (score >= 100) return 'covered';
  if (score > 0) return 'partial';
  return 'missing';
}

function missingReference(name: string): EvaluatorOutput {
  const summary = `未标注参考答案，无法运行${name}——不记分。`;
  return { summary, evidence: { json: { unscoredReason: summary } } };
}

const REFERENCE_TEXT_PRESET_NAMES: Record<ReferenceTextPresetId, string> = {
  'preset-text-rouge': 'ROUGE 指标评估',
  'preset-text-exact-match': '完全精确匹配评估',
  'preset-text-entity-f1': '实体 F1 匹配评估',
};

async function runReferenceTextPreset(
  id: ReferenceTextPresetId,
  ctx: FaithfulPresetContext,
  config?: ExactMatchRunConfig | EntityF1RunConfig,
): Promise<EvaluatorOutput> {
  if (ctx.referenceOutput === null || !ctx.referenceOutput.trim()) {
    return missingReference(REFERENCE_TEXT_PRESET_NAMES[id]);
  }

  if (id === 'preset-text-rouge') return runRouge(ctx.actualOutput, ctx.referenceOutput);
  if (id === 'preset-text-exact-match') {
    return runExactMatch(
      ctx.actualOutput,
      ctx.referenceOutput,
      normalizeExactMatchRunConfig(config),
    );
  }
  return runEntityF1(
    ctx.actualOutput,
    ctx.referenceOutput,
    normalizeEntityF1RunConfig(config),
  );
}

async function runRouge(generatedText: string, referenceText: string): Promise<EvaluatorOutput> {
  const { gradeRouge } = await import('../evaluation/rouge-grader');
  const result = gradeRouge(generatedText, referenceText);
  const metrics = [
    { label: 'ROUGE-1（unigram，单词重叠）', value: result.reason.rouge1 },
    { label: 'ROUGE-2（bigram，连续两词重叠）', value: result.reason.rouge2 },
    { label: 'ROUGE-L（LCS，最长公共子序列）', value: result.reason.rougeL },
  ];
  const points: EvalPoint[] = metrics.map(({ label, value }) => {
    const score = to100(value.f1);
    return {
      label,
      score,
      status: statusOf(score),
      evidence: {
        json: {
          precision: to100(value.precision),
          recall: to100(value.recall),
          f1: score,
          ...('overlapCount' in value ? {
            overlapCount: value.overlapCount,
            generatedNgramCount: value.generatedCount,
            referenceNgramCount: value.referenceCount,
          } : {
            lcsLength: value.lcsLength,
            generatedTokenCount: value.generatedCount,
            referenceTokenCount: value.referenceCount,
          }),
        },
      },
    };
  });
  const score = to100(result.score);
  const [rouge1, rouge2, rougeL] = points.map((point) => point.score ?? 0);
  return normalizeEvaluatorOutput({
    summary: `ROUGE 综合得分 ${score}；单词重叠 ROUGE-1（unigram）${rouge1}、双词连贯 ROUGE-2（bigram）${rouge2}、最长公共子序列 ROUGE-L（LCS）${rougeL}。`,
    score,
    points,
    evidence: {
      json: {
        metric: 'ROUGE',
        formula: '总分 = [单词重叠 ROUGE-1（unigram） + 双词连贯 ROUGE-2（bigram） + 最长公共子序列 ROUGE-L（LCS）] 三项 F1（精确率与召回率的调和平均）的算术平均值',
        score,
        tokenizer: result.reason.tokenizer,
        generatedTokenCount: result.reason.generatedTokenCount,
        referenceTokenCount: result.reason.referenceTokenCount,
      },
    },
  });
}

function parseExactMatchCandidates(referenceText: string): string | string[] {
  const trimmed = referenceText.trim();
  if (!trimmed.startsWith('[')) return referenceText;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((candidate) => typeof candidate === 'string')) return parsed;
  } catch {
    // 不是合法候选数组时仍按普通参考文本严格比较。
  }
  return referenceText;
}

async function runExactMatch(
  output: string,
  referenceText: string,
  config: ExactMatchRunConfig,
): Promise<EvaluatorOutput> {
  const { gradeExactMatch } = await import('../evaluation/exact-match-grader');
  const result = gradeExactMatch(output, parseExactMatchCandidates(referenceText), config);
  const score = to100(result.score);
  const matched = result.reason.matchedCandidateIndices[0];
  const summary = matched === undefined
    ? '标准化后的输出未与任何参考答案完全匹配。'
    : `标准化后的输出与第 ${matched + 1} 个参考答案完全匹配。`;
  return normalizeEvaluatorOutput({
    verdict: score === 100 ? 'pass' : 'fail',
    summary,
    score,
    points: [{
      label: '完全匹配（逐字一致）',
      score,
      status: statusOf(score),
      evidence: { json: result.reason },
    }],
    evidence: { json: { metric: 'Exact Match', score, ...result.reason } },
  });
}

async function runEntityF1(
  actualOutput: string,
  referenceText: string,
  config: EntityF1RunConfig,
): Promise<EvaluatorOutput> {
  let references: string[];
  try {
    references = parseEntityList(referenceText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      summary: `参考答案格式无效，无法运行实体 F1 匹配——不记分：${message}`,
      evidence: { json: { unscoredReason: message, referenceOutput: referenceText, config } },
    };
  }

  let predictions: string[];
  try {
    predictions = parseEntityList(actualOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return normalizeEvaluatorOutput({
      verdict: 'fail',
      summary: `Agent 输出不是有效实体数组，实体 F1 记 0 分：${message}`,
      score: 0,
      points: [{
        label: '实体 F1',
        score: 0,
        status: 'missing',
        evidence: { json: { parseError: message, actualOutput, config } },
      }],
      evidence: { json: { metric: 'Entity F1', score: 0, parseError: message, actualOutput, config } },
    });
  }

  const { gradeF1Match } = await import('../evaluation/f1-match-grader');
  const result = gradeF1Match(predictions, references, config);
  const precision = to100(result.reason.precision);
  const recall = to100(result.reason.recall);
  const f1 = to100(result.reason.f1);
  const points: EvalPoint[] = [
    {
      label: '精确率（识别出的实体中正确的比例）',
      score: precision,
      status: statusOf(precision),
      evidence: {
        json: {
          truePositiveCount: result.reason.truePositiveCount,
          predictedCount: result.reason.predictedEntities.length,
        },
      },
    },
    {
      label: '召回率（标准实体被成功找出的比例）',
      score: recall,
      status: statusOf(recall),
      evidence: {
        json: {
          truePositiveCount: result.reason.truePositiveCount,
          referenceCount: result.reason.referenceEntities.length,
        },
      },
    },
    {
      label: '实体 F1（精确率与召回率的调和平均）',
      score: f1,
      status: statusOf(f1),
      evidence: { json: result.reason },
    },
  ];
  return normalizeEvaluatorOutput({
    summary: `实体 F1（精确率与召回率的调和平均）${f1}；正确识别 ${result.reason.truePositiveCount} 个，误报 ${result.reason.falsePositiveCount} 个，遗漏 ${result.reason.falseNegativeCount} 个。`,
    score: f1,
    points,
    evidence: {
      json: {
        metric: 'Entity F1',
        score: f1,
        ...result.reason,
        precision,
        recall,
        f1,
      },
    },
  });
}
