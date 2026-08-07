/**
 * “回答深度性”预置评估器。
 *
 * Judge Prompt：src/prompts/result-depth-prompt.ts
 *
 * 算法：
 * 1. Judge 先为五个维度判断所需深度 none/light/full，再判断达成档位 met/partial/missing。
 * 2. none 表示当前任务无需展开该维度，作为 N/A 不计入分子、分母或评分点状态。
 * 3. 档位映射：met=100、partial=50、missing=0。
 * 4. 总分 = Σ(适用维度权重×档位分) ÷ Σ(适用维度权重)；全部维度均为 none 时不出分。
 * 5. Judge 遗漏或重复维度时抛 JudgeOutputParseError，由实验引擎重试；最终分数限制在 0–100。
 */
import { z } from 'zod';
import {
  normalizeEvaluatorOutput,
  type EvalPoint,
  type EvaluatorOutput,
} from '@/lib/evaluators/eval-output';
import {
  generateResultDepthPrompt,
  RESULT_DEPTH_DIMENSION_KEYS,
  RESULT_DEPTH_DIMENSIONS,
  type ResultDepthDimension,
} from '@/prompts/result-depth-prompt';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import {
  SPECIALIZED_RUBRIC_VERSION,
  VERDICTS,
  VERDICT_SCORE,
  VERDICT_STATUS,
  indexCompleteDimensions,
  invokeSpecializedJudge,
  roundScore,
  uniqueStrings,
  type DimensionJudgment,
} from './specialized-evaluator-common';

export const DEPTH_PRESET_ID = 'preset-depth-result' as const;
export function isDepthPresetId(id: string): id is typeof DEPTH_PRESET_ID {
  return id === DEPTH_PRESET_ID;
}

const DEPTH_WEIGHTS: Record<ResultDepthDimension, number> = {
  causal_depth: 0.25,
  structured_reasoning: 0.25,
  multi_perspective_tradeoff: 0.20,
  context_provision: 0.15,
  insight_synthesis: 0.15,
};
const DEPTH_DIMENSIONS = RESULT_DEPTH_DIMENSIONS.map((item) => ({
  ...item,
  weight: DEPTH_WEIGHTS[item.key],
}));
const DEPTH_KEYS = RESULT_DEPTH_DIMENSION_KEYS;
export type DepthDimension = ResultDepthDimension;
export type RequiredDepth = 'none' | 'light' | 'full';

export interface DepthDimensionJudgment extends DimensionJudgment<DepthDimension> {
  requiredDepth: RequiredDepth;
  requiredDepthReason?: string;
}

export interface DepthJudgeResult {
  summary?: string;
  dimensions: DepthDimensionJudgment[];
  issues?: Array<{ dimension: DepthDimension; reason: string }>;
  suggestions?: string[];
}

const depthDimensionSchema = z.object({
  dimension: z.enum(DEPTH_KEYS),
  verdict: z.enum(VERDICTS),
  reason: z.string().trim().min(1),
  suggestion: z.string(),
  requiredDepth: z.enum(['none', 'light', 'full']),
  requiredDepthReason: z.string().trim().min(1),
}).superRefine((value, ctx) => {
  if (value.requiredDepth === 'none' && value.verdict !== 'met') {
    ctx.addIssue({ code: 'custom', path: ['verdict'], message: 'requiredDepth=none 时 verdict 必须为 met' });
  }
  if (value.requiredDepth === 'none' && value.suggestion.trim()) {
    ctx.addIssue({ code: 'custom', path: ['suggestion'], message: 'requiredDepth=none 时 suggestion 必须为空' });
  }
  if (value.verdict !== 'met' && !value.suggestion.trim()) {
    ctx.addIssue({ code: 'custom', path: ['suggestion'], message: 'partial/missing 必须提供改进建议' });
  }
});

const depthJudgeSchema = z.object({
  summary: z.string().trim().min(1).max(200).optional(),
  dimensions: z.array(depthDimensionSchema).length(DEPTH_KEYS.length),
  issues: z.array(z.object({
    dimension: z.enum(DEPTH_KEYS),
    reason: z.string().trim().min(1),
  })).default([]),
  suggestions: z.array(z.string()).default([]),
});

export function buildDepthEvaluatorOutput(result: DepthJudgeResult): EvaluatorOutput {
  const byDimension = indexCompleteDimensions(DEPTH_KEYS, result.dimensions);
  const applicableDefinitions = DEPTH_DIMENSIONS.filter((definition) => (
    byDimension.get(definition.key)?.requiredDepth !== 'none'
  ));
  const applicableWeight = applicableDefinitions.reduce((sum, definition) => sum + definition.weight, 0);
  const score = applicableWeight > 0
    ? roundScore(applicableDefinitions.reduce((sum, definition) => {
      const judgment = byDimension.get(definition.key)!;
      return sum + VERDICT_SCORE[judgment.verdict] * definition.weight;
    }, 0) / applicableWeight)
    : undefined;
  const dimensions = DEPTH_DIMENSIONS.map((definition) => {
    const judgment = byDimension.get(definition.key)!;
    if (judgment.requiredDepth === 'none') {
      return {
        key: definition.key,
        requiredDepth: judgment.requiredDepth,
        requiredDepthReason: judgment.requiredDepthReason ?? '',
        includedInScore: false,
        verdict: 'not_applicable',
        reason: judgment.reason,
        unscoredReason: '该维度对当前任务不适用，不计入总分。',
      };
    }
    return {
      key: definition.key,
      requiredDepth: judgment.requiredDepth,
      requiredDepthReason: judgment.requiredDepthReason ?? '',
      includedInScore: true,
      verdict: judgment.verdict,
      score: VERDICT_SCORE[judgment.verdict],
      reason: judgment.reason,
    };
  });
  const points: EvalPoint[] = DEPTH_DIMENSIONS.map((definition) => {
    const judgment = byDimension.get(definition.key)!;
    if (judgment.requiredDepth === 'none') {
      return {
        label: definition.label,
        evidence: {
          md: `不适用：${judgment.requiredDepthReason || '该维度对完成当前任务不必要'}（不计入总分）`,
        },
      };
    }
    return {
      label: definition.label,
      score: VERDICT_SCORE[judgment.verdict],
      status: VERDICT_STATUS[judgment.verdict],
      evidence: {
        json: {
          requiredDepth: judgment.requiredDepth,
          requiredDepthReason: judgment.requiredDepthReason ?? '',
          verdict: judgment.verdict,
          reason: judgment.reason,
        },
      },
      suggestion: judgment.suggestion || undefined,
    };
  });
  const unmetDimensions = new Set(DEPTH_DIMENSIONS
    .filter((definition) => {
      const judgment = byDimension.get(definition.key);
      return judgment?.requiredDepth !== 'none' && judgment?.verdict !== 'met';
    })
    .map((definition) => definition.key));
  const issues = (result.issues ?? []).filter((issue) => unmetDimensions.has(issue.dimension));
  const suggestions = unmetDimensions.size === 0 ? [] : uniqueStrings([
    ...(result.suggestions ?? []),
    ...applicableDefinitions.map((definition) => byDimension.get(definition.key)?.suggestion),
  ]);
  const verdictCount = (verdict: 'met' | 'partial' | 'missing') => applicableDefinitions.filter(
    (definition) => byDimension.get(definition.key)?.verdict === verdict,
  ).length;
  const fallbackSummary = score === undefined
    ? '所有深度维度均不适用于当前任务，本次不计分。'
    : unmetDimensions.size === 0
      ? `适用的 ${applicableDefinitions.length} 个深度维度均已达成，回答深度符合本题要求。`
      : `适用的 ${applicableDefinitions.length} 个深度维度中，达成 ${verdictCount('met')} 项、部分达成 ${verdictCount('partial')} 项、未达成 ${verdictCount('missing')} 项。`;
  const summary = result.summary?.trim() || fallbackSummary;
  return normalizeEvaluatorOutput({
    ...(score === undefined ? {} : { score }),
    summary,
    points,
    evidence: {
      json: {
        rubricVersion: SPECIALIZED_RUBRIC_VERSION,
        dimensions,
        applicableWeight: roundScore(applicableWeight * 100),
        aggregation: '适用维度按原权重重新归一化后聚合',
        ...(score === undefined ? { unscoredReason: '所有深度维度均不适用于当前任务。' } : {}),
        issues,
        suggestions,
      },
    },
  });
}


function depthPrompt(ctx: FaithfulPresetContext) {
  return generateResultDepthPrompt({ query: ctx.caseInput, actualOutput: ctx.actualOutput });
}

export async function runDepthPreset(
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  const judgment = await invokeSpecializedJudge(user, depthPrompt(ctx), depthJudgeSchema);
  return buildDepthEvaluatorOutput(judgment);
}
