import { z } from 'zod';
import { buildResultAccuracyPrompt } from '@/prompts/result-accuracy-prompt';
import type { StructuredResultInvoker } from './instruction-adherence-evaluator';
import { extractOutputClaims } from './faithfulness-evaluator';

/**
 * 结果准确性（精确率口径）：从**实际输出**抽出主张，逐条对**参考答案**判对错。
 * - 主张来自实际输出，与忠实度共用同一批 claim（抽取带缓存，一次抽两处用）。
 * - 「该说的没说」不在此扣分——那是完整性（任务完成度）的职责。
 * - correct/partially_correct/wrong 全部计入分母，说错的会直接拉低分数；
 *   参考答案未涉及的主张（not_in_reference）无从判对错，不计入分母。
 */
const findingStatusSchema = z.enum(['correct', 'partially_correct', 'wrong', 'not_in_reference']);
const accuracyJudgeSchema = z.object({
  claim_findings: z.array(z.object({
    claim_id: z.string().min(1),
    status: findingStatusSchema,
    score: z.number().min(0).max(1).nullable().default(null),
    expected_evidence: z.string().default(''),
    reason: z.string().default(''),
    confidence: z.number().min(0).max(1).default(0),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().default(''),
});

export type AccuracyJudgePayload = z.output<typeof accuracyJudgeSchema>;
export type AccuracyFindingStatus = z.output<typeof findingStatusSchema>;

export interface AccuracyClaim {
  claimId: string;
  claim: string;
  sourceQuote: string;
}

export interface AccuracyEvaluationResult {
  score: number | null;
  confidence: number;
  note?: string;
  evidence: {
    reason: string;
    claimFindings: Array<{
      claimId: string;
      claim: string;
      sourceQuote: string;
      status: AccuracyFindingStatus;
      score: number | null;
      expectedEvidence: string;
      reason: string;
      confidence: number;
    }>;
    counts: {
      judged: number;
      correct: number;
      partiallyCorrect: number;
      wrong: number;
      notInReference: number;
    };
  };
}

/** 状态即分数（不信任模型自报的 score，避免 status/score 不一致导致整次评估失败）。 */
const STATUS_SCORE: Record<AccuracyFindingStatus, number | null> = {
  correct: 1,
  partially_correct: 0.5,
  wrong: 0,
  not_in_reference: null,
};

export function scoreAccuracyJudgePayload(input: {
  payload: AccuracyJudgePayload;
  claims: AccuracyClaim[];
}): AccuracyEvaluationResult {
  const { payload, claims } = input;
  const findingById = new Map(payload.claim_findings.map(item => [item.claim_id, item]));

  let numerator = 0;
  let denominator = 0;
  const claimFindings = claims.map(claim => {
    const finding = findingById.get(claim.claimId);
    // 模型漏判的主张按「参考未涉及」处理，不计入分母，也不让整次评估失败
    const status: AccuracyFindingStatus = finding?.status ?? 'not_in_reference';
    const score = STATUS_SCORE[status];
    if (status !== 'not_in_reference') {
      denominator += 1;
      numerator += score ?? 0;
    }
    return {
      claimId: claim.claimId,
      claim: claim.claim,
      sourceQuote: claim.sourceQuote,
      status,
      score,
      expectedEvidence: finding?.expected_evidence ?? '',
      reason: finding?.reason ?? (finding ? '' : '模型未对该主张给出判定'),
      confidence: finding?.confidence ?? 0,
    };
  });

  const counts = {
    judged: denominator,
    correct: claimFindings.filter(item => item.status === 'correct').length,
    partiallyCorrect: claimFindings.filter(item => item.status === 'partially_correct').length,
    wrong: claimFindings.filter(item => item.status === 'wrong').length,
    notInReference: claimFindings.filter(item => item.status === 'not_in_reference').length,
  };
  const score = denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
  const note = score == null ? '实际输出的主张均未被参考答案涉及，无法判定准确性' : undefined;
  const confidences = claimFindings.map(item => item.confidence).filter(Number.isFinite);
  const findingConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : payload.confidence;
  const confidence = score == null
    ? 0
    : Math.round(Math.min(payload.confidence, findingConfidence) * 1000) / 1000;

  return {
    score,
    confidence,
    note,
    evidence: {
      reason: payload.reason || note || '准确性评测完成',
      claimFindings,
      counts,
    },
  };
}

export async function evaluateResultAccuracy(input: {
  query: string;
  expectedOutput: string;
  actualOutput: string;
  invoke: StructuredResultInvoker;
}): Promise<AccuracyEvaluationResult> {
  const extracted = await extractOutputClaims({
    query: input.query,
    finalResult: input.actualOutput,
    invoke: input.invoke,
  });
  const claims: AccuracyClaim[] = extracted.claims.map(item => ({
    claimId: item.claimId,
    claim: item.claim,
    sourceQuote: item.sourceQuote,
  }));
  if (!claims.length) {
    const note = '实际输出没有可验证主张';
    return {
      score: null,
      confidence: 0,
      note,
      evidence: {
        reason: note,
        claimFindings: [],
        counts: { judged: 0, correct: 0, partiallyCorrect: 0, wrong: 0, notInReference: 0 },
      },
    };
  }

  const payload = await input.invoke(
    buildResultAccuracyPrompt({
      query: input.query,
      expectedOutput: input.expectedOutput,
      actualOutput: input.actualOutput,
      claims,
    }),
    accuracyJudgeSchema,
  );
  return scoreAccuracyJudgePayload({ payload, claims });
}
