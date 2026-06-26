import { createHash } from 'crypto';
import { z } from 'zod';
import type { RootCauseItem } from '@/lib/dataset-case-root-causes';
import { buildResultAccuracyPrompt } from '@/prompts/result-accuracy-prompt';
import type { StructuredResultInvoker } from './instruction-adherence-evaluator';

const findingStatusSchema = z.enum(['correct', 'partially_correct', 'wrong', 'not_mentioned']);
const accuracyJudgeSchema = z.object({
  key_point_findings: z.array(z.object({
    key_point_id: z.string().min(1),
    status: findingStatusSchema,
    score: z.number().min(0).max(1).nullable(),
    actual_evidence: z.string().default(''),
    expected_evidence: z.string().default(''),
    reason: z.string().default(''),
    confidence: z.number().min(0).max(1).default(0),
  })),
  additional_errors: z.array(z.object({
    kind: z.enum(['incorrect_fact', 'extra_content']),
    severity: z.enum(['low', 'medium', 'high']),
    actual_evidence: z.string().min(1),
    reason: z.string().default(''),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0),
  reason: z.string().default(''),
});

export type AccuracyJudgePayload = z.output<typeof accuracyJudgeSchema>;
export type AccuracyFindingStatus = z.output<typeof findingStatusSchema>;

export interface AccuracyKeyPoint extends RootCauseItem {
  id: string;
}

export interface AccuracyEvaluationResult {
  score: number | null;
  confidence: number;
  note?: string;
  evidence: {
    reason: string;
    keyPointFindings: Array<{
      keyPointId: string;
      content: string;
      weight: number;
      status: AccuracyFindingStatus;
      score: number | null;
      actualEvidence: string;
      expectedEvidence: string;
      reason: string;
      confidence: number;
    }>;
    additionalErrors: AccuracyJudgePayload['additional_errors'];
    counts: {
      mentioned: number;
      correct: number;
      partiallyCorrect: number;
      wrong: number;
      notMentioned: number;
      additionalErrors: number;
    };
  };
}

const STATUS_SCORE: Record<AccuracyFindingStatus, number | null> = {
  correct: 1,
  partially_correct: 0.5,
  wrong: 0,
  not_mentioned: null,
};

const ERROR_WEIGHT = { low: 0.5, medium: 1, high: 2 } as const;

function clampWeight(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 1;
}

export function normalizeAccuracyKeyPoints(items: RootCauseItem[]): AccuracyKeyPoint[] {
  return items
    .map((item, index) => ({
      id: `K${index + 1}`,
      content: String(item.content || '').trim(),
      weight: clampWeight(item.weight),
    }))
    .filter(item => Boolean(item.content));
}

export function hashAccuracyKeyPoints(items: AccuracyKeyPoint[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

export function scoreAccuracyJudgePayload(input: {
  payload: AccuracyJudgePayload;
  keyPoints: AccuracyKeyPoint[];
  expectedOutput: string;
  actualOutput: string;
}): AccuracyEvaluationResult {
  const { payload, keyPoints } = input;
  const keyPointById = new Map(keyPoints.map(item => [item.id, item]));
  const findingsById = new Map<string, AccuracyJudgePayload['key_point_findings'][number]>();

  for (const finding of payload.key_point_findings) {
    if (!keyPointById.has(finding.key_point_id)) {
      throw new Error(`准确性评测返回未知 key_point_id: ${finding.key_point_id}`);
    }
    if (findingsById.has(finding.key_point_id)) {
      throw new Error(`准确性评测重复返回 key_point_id: ${finding.key_point_id}`);
    }
    findingsById.set(finding.key_point_id, finding);
  }
  if (findingsById.size !== keyPoints.length) {
    const missing = keyPoints.filter(item => !findingsById.has(item.id)).map(item => item.id);
    throw new Error(`准确性评测缺少关键观点判断: ${missing.join(', ')}`);
  }

  let numerator = 0;
  let denominator = 0;
  const normalizedFindings = keyPoints.map(keyPoint => {
    const finding = findingsById.get(keyPoint.id)!;
    const derivedScore = STATUS_SCORE[finding.status];
    if (finding.score !== derivedScore) {
      throw new Error(`关键观点 ${keyPoint.id} 的 status 与 score 不一致`);
    }
    if (finding.status === 'not_mentioned') {
      if (finding.actual_evidence.trim()) {
        throw new Error(`关键观点 ${keyPoint.id} 为 not_mentioned 时 actual_evidence 必须为空`);
      }
    } else {
      denominator += keyPoint.weight;
      numerator += keyPoint.weight * (derivedScore ?? 0);
    }
    return {
      keyPointId: keyPoint.id,
      content: keyPoint.content,
      weight: keyPoint.weight,
      status: finding.status,
      score: derivedScore,
      actualEvidence: finding.actual_evidence,
      expectedEvidence: finding.expected_evidence,
      reason: finding.reason,
      confidence: finding.confidence,
    };
  });

  for (const issue of payload.additional_errors) {
    denominator += ERROR_WEIGHT[issue.severity];
  }

  const confidences = normalizedFindings.map(item => item.confidence).filter(Number.isFinite);
  const findingConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : payload.confidence;
  const confidence = Math.round(Math.min(payload.confidence, findingConfidence) * 1000) / 1000;
  const counts = {
    mentioned: normalizedFindings.filter(item => item.status !== 'not_mentioned').length,
    correct: normalizedFindings.filter(item => item.status === 'correct').length,
    partiallyCorrect: normalizedFindings.filter(item => item.status === 'partially_correct').length,
    wrong: normalizedFindings.filter(item => item.status === 'wrong').length,
    notMentioned: normalizedFindings.filter(item => item.status === 'not_mentioned').length,
    additionalErrors: payload.additional_errors.length,
  };
  const score = denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : null;
  const note = score == null ? '实际输出没有涉及可评测关键观点' : undefined;

  return {
    score,
    confidence: score == null ? 0 : confidence,
    note,
    evidence: {
      reason: payload.reason || note || '准确性评测完成',
      keyPointFindings: normalizedFindings,
      additionalErrors: payload.additional_errors,
      counts,
    },
  };
}

export async function evaluateResultAccuracy(input: {
  query: string;
  expectedOutput: string;
  actualOutput: string;
  keyPoints: AccuracyKeyPoint[];
  invoke: StructuredResultInvoker;
}): Promise<AccuracyEvaluationResult> {
  const payload = await input.invoke(
    buildResultAccuracyPrompt(input),
    accuracyJudgeSchema,
  );
  return scoreAccuracyJudgePayload({
    payload,
    keyPoints: input.keyPoints,
    expectedOutput: input.expectedOutput,
    actualOutput: input.actualOutput,
  });
}
