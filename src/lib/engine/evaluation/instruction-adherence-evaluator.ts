import { z } from 'zod';
import {
  generateInstructionConstraintExtractionPrompt,
  generateInstructionVerdictPrompt,
  INSTRUCTION_CONSTRAINT_TYPES,
} from '@/prompts/result-instruction-adherence-prompt';

export type StructuredJudgePrompt = { stage: string; system: string; user: string };
export type StructuredResultInvoker = <S extends z.ZodTypeAny>(
  prompt: StructuredJudgePrompt,
  schema: S,
) => Promise<z.output<S>>;

const instructionConstraintSchema = z.object({
  constraints: z.array(z.object({
    id: z.string().min(1),
    source: z.enum(['user', 'system']),
    sourceQuote: z.string().min(1),
    type: z.enum(INSTRUCTION_CONSTRAINT_TYPES),
    text: z.string().min(1),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

const instructionVerdictSchema = z.object({
  verdicts: z.array(z.object({
    constraintId: z.string().min(1),
    status: z.enum(['met', 'not_met', 'not_applicable']),
    reason: z.string().min(1),
    evidenceQuote: z.string().default(''),
    observedValue: z.string().default(''),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

export type InstructionConstraint = z.output<typeof instructionConstraintSchema>['constraints'][number];
export type InstructionVerdict = z.output<typeof instructionVerdictSchema>['verdicts'][number];

export interface InstructionAdherenceEvaluation {
  score: number | null;
  confidence: number;
  evidence: Record<string, unknown>;
  note?: string;
}

function clampScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

function assertUniqueIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} 包含重复 ID`);
}

function assertSameIds(expected: string[], actual: string[], label: string): void {
  assertUniqueIds(expected, `${label} 输入`);
  assertUniqueIds(actual, `${label} 输出`);
  const expectedSet = new Set(expected);
  if (actual.length !== expected.length || actual.some((id) => !expectedSet.has(id))) {
    throw new Error(`${label} 输出 ID 与输入不一致`);
  }
}

export function validateInstructionConstraints(
  constraints: InstructionConstraint[],
): void {
  assertUniqueIds(constraints.map((item) => item.id), '指令约束');
}

export function validateInstructionVerdicts(
  constraints: Array<Pick<InstructionConstraint, 'id'>>,
  verdicts: InstructionVerdict[],
): void {
  assertSameIds(
    constraints.map((item) => item.id),
    verdicts.map((item) => item.constraintId),
    '指令裁决',
  );
}

export function scoreInstructionVerdicts(verdicts: Array<{ status: string }>): number | null {
  const applicable = verdicts.filter((item) => item.status !== 'not_applicable');
  if (!applicable.length) return null;
  return clampScore((applicable.filter((item) => item.status === 'met').length / applicable.length) * 100);
}

export function buildInstructionReason(
  constraints: InstructionConstraint[],
  verdicts: InstructionVerdict[],
): string {
  const applicable = verdicts.filter((item) => item.status !== 'not_applicable');
  const failed = verdicts.filter((item) => item.status === 'not_met');
  if (!applicable.length) return '本任务没有适用的输出约束。';
  if (!failed.length) {
    return `${applicable.length} 项输出约束全部满足：${constraints
      .filter((item) => applicable.some((verdict) => verdict.constraintId === item.id))
      .map((item) => item.text)
      .join('、')}。`;
  }
  const constraintById = new Map(constraints.map((item) => [item.id, item]));
  return `${applicable.length} 项输出约束满足 ${applicable.length - failed.length} 项；未满足：${failed
    .map((item) => constraintById.get(item.constraintId)?.text ?? item.constraintId)
    .join('、')}。`;
}

export async function evaluateInstructionAdherence(input: {
  query: string;
  relevantSystemInstructions: string[];
  finalResult: string;
  invoke: StructuredResultInvoker;
}): Promise<InstructionAdherenceEvaluation> {
  const extracted = await input.invoke(
    generateInstructionConstraintExtractionPrompt({
      query: input.query,
      relevantSystemInstructions: input.relevantSystemInstructions,
    }),
    instructionConstraintSchema,
  );
  validateInstructionConstraints(extracted.constraints);
  if (!extracted.constraints.length) {
    const note = '本任务没有明确的输出约束';
    return {
      score: null,
      confidence: extracted.confidence,
      note,
      evidence: { constraints: [], verdicts: [], extractionConfidence: extracted.confidence, reason: note },
    };
  }

  const judged = await input.invoke(
    generateInstructionVerdictPrompt({
      query: input.query,
      constraints: extracted.constraints.map(({ id, type, text }) => ({ id, type, text })),
      finalResult: input.finalResult,
    }),
    instructionVerdictSchema,
  );
  validateInstructionVerdicts(extracted.constraints, judged.verdicts);
  const score = scoreInstructionVerdicts(judged.verdicts);
  const reason = buildInstructionReason(extracted.constraints, judged.verdicts);
  if (score == null) {
    return {
      score: null,
      confidence: Math.min(extracted.confidence, judged.confidence),
      note: reason,
      evidence: {
        constraints: extracted.constraints,
        verdicts: judged.verdicts,
        extractionConfidence: extracted.confidence,
        verdictConfidence: judged.confidence,
        reason,
      },
    };
  }
  return {
    score,
    confidence: Math.min(extracted.confidence, judged.confidence),
    evidence: {
      constraints: extracted.constraints,
      verdicts: judged.verdicts,
      summary: {
        met: judged.verdicts.filter((item) => item.status === 'met').length,
        notMet: judged.verdicts.filter((item) => item.status === 'not_met').length,
        notApplicable: judged.verdicts.filter((item) => item.status === 'not_applicable').length,
      },
      extractionConfidence: extracted.confidence,
      verdictConfidence: judged.confidence,
      reason,
    },
  };
}
