import { z } from 'zod';
import {
  generateAnswerCoherencePrompt,
  generateAnswerRequirementsPrompt,
  generateAnswerStatementsPrompt,
  generateRequirementCompletenessPrompt,
  generateStatementRelevancePrompt,
} from '@/prompts/result-answer-quality-prompt';
import type { StructuredResultInvoker } from './instruction-adherence-evaluator';

const answerStatementsSchema = z.object({
  statements: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    sourceQuote: z.string().min(1),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

const answerRequirementsSchema = z.object({
  requirements: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    importance: z.number().int().min(1).max(3),
    sourceQuote: z.string().min(1),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

const answerRelevanceSchema = z.object({
  verdicts: z.array(z.object({
    statementId: z.string().min(1),
    verdict: z.enum(['relevant', 'supporting', 'irrelevant']),
    reason: z.string().default(''),
  })).default([]),
  noncommittal: z.object({ value: z.boolean(), reason: z.string().default('') }),
  confidence: z.number().min(0).max(1).default(0),
});

const answerCompletenessSchema = z.object({
  verdicts: z.array(z.object({
    requirementId: z.string().min(1),
    status: z.enum(['covered', 'partial', 'missing']),
    reason: z.string().default(''),
    evidenceQuote: z.string().default(''),
  })).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

// LLM 有时把 issue 直接返回成字符串（而非 {quote,reason} 对象）——宽容转成对象，避免整次评估因此 schema 失败
const issueSchema = z.preprocess(
  (v) => (typeof v === 'string' ? { quote: v } : v),
  z.object({ quote: z.string().min(1), reason: z.string().default('') }),
);
const answerCoherenceSchema = z.object({
  rating: z.number().int().min(0).max(4),
  checks: z.object({
    mainConclusionClear: z.boolean(),
    logicalOrder: z.boolean(),
    referenceConsistency: z.boolean(),
    contradictions: z.array(issueSchema).default([]),
    repetitions: z.array(issueSchema).default([]),
    abruptTransitions: z.array(issueSchema).default([]),
  }),
  reason: z.string().default(''),
  confidence: z.number().min(0).max(1).default(0),
});

type Statement = z.output<typeof answerStatementsSchema>['statements'][number];
type Requirement = z.output<typeof answerRequirementsSchema>['requirements'][number];
type RelevanceVerdict = z.output<typeof answerRelevanceSchema>['verdicts'][number];
type CompletenessVerdict = z.output<typeof answerCompletenessSchema>['verdicts'][number];
type CoherenceResult = z.output<typeof answerCoherenceSchema>;

export interface AnswerQualityEvaluation {
  score: number | null;
  confidence: number;
  evidence: Record<string, unknown>;
  note?: string;
}

const MAX_ANSWER_STATEMENTS = 24;

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

function unwrapSettled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

export function validateAnswerStatements(statements: Statement[]): void {
  assertUniqueIds(statements.map((item) => item.id), '答案陈述');
}

function limitAnswerStatements(statements: Statement[]): Statement[] {
  return statements.slice(0, MAX_ANSWER_STATEMENTS);
}

export function validateAnswerRequirements(requirements: Requirement[]): void {
  assertUniqueIds(requirements.map((item) => item.id), '任务要点');
}

export function scoreAnswerRelevance(
  verdicts: Array<{ verdict: 'relevant' | 'supporting' | 'irrelevant' }>,
  noncommittal = false,
): number | null {
  if (!verdicts.length) return null;
  const relevantCount = verdicts.filter((item) => item.verdict === 'relevant').length;
  if (noncommittal && relevantCount === 0) return 0;
  const values = { relevant: 1, supporting: 0.5, irrelevant: 0 } as const;
  return clampScore((verdicts.reduce((sum, item) => sum + values[item.verdict], 0) / verdicts.length) * 100);
}

export function scoreAnswerCompleteness(
  requirements: Array<{ id: string; importance: number }>,
  verdicts: Array<{ requirementId: string; status: 'covered' | 'partial' | 'missing' }>,
): number | null {
  if (!requirements.length) return null;
  const values = { covered: 1, partial: 0.5, missing: 0 } as const;
  const verdictById = new Map(verdicts.map((item) => [item.requirementId, item]));
  const totalWeight = requirements.reduce((sum, item) => sum + item.importance, 0);
  if (!totalWeight) return null;
  const coveredWeight = requirements.reduce((sum, item) => {
    const verdict = verdictById.get(item.id);
    return sum + item.importance * (verdict ? values[verdict.status] : 0);
  }, 0);
  return clampScore((coveredWeight / totalWeight) * 100);
}

export function scoreAnswerQuality(input: {
  relevance: number;
  completeness: number;
  coherence: number;
}): number {
  return clampScore(input.relevance * 0.3 + input.completeness * 0.5 + input.coherence * 0.2);
}

function validateRelevanceVerdicts(statements: Statement[], verdicts: RelevanceVerdict[]): void {
  assertSameIds(statements.map((item) => item.id), verdicts.map((item) => item.statementId), '相关性裁决');
}

function validateCompletenessVerdicts(requirements: Requirement[], verdicts: CompletenessVerdict[]): void {
  assertSameIds(requirements.map((item) => item.id), verdicts.map((item) => item.requirementId), '完整性裁决');
}

export function buildAnswerQualityReason(input: {
  requirements: Requirement[];
  completenessVerdicts: CompletenessVerdict[];
  relevanceVerdicts: RelevanceVerdict[];
  noncommittal: boolean;
  coherence: CoherenceResult;
}): string {
  const pieces: string[] = [];
  const incomplete = input.completenessVerdicts.filter((item) => item.status !== 'covered');
  if (!incomplete.length) pieces.push(`${input.requirements.length} 个必答要点均充分覆盖`);
  else {
    const requirementById = new Map(input.requirements.map((item) => [item.id, item.text]));
    pieces.push(`未充分覆盖：${incomplete.map((item) => requirementById.get(item.requirementId) ?? item.requirementId).join('、')}`);
  }
  const irrelevant = input.relevanceVerdicts.filter((item) => item.verdict === 'irrelevant');
  if (input.noncommittal) pieces.push('回答存在回避或含糊表述');
  else if (irrelevant.length) pieces.push(`${irrelevant.length} 条陈述与任务无关`);
  else pieces.push('内容直接相关');
  if (input.coherence.rating === 4) pieces.push('组织清晰');
  else pieces.push(input.coherence.reason.replace(/[。；]+$/u, '') || '组织表达存在瑕疵');
  return `${pieces.join('；')}。`;
}

export async function evaluateAnswerQuality(input: {
  query: string;
  finalResult: string;
  invoke: StructuredResultInvoker;
}): Promise<AnswerQualityEvaluation> {
  const statementsPromise = input.invoke(generateAnswerStatementsPrompt(input.finalResult), answerStatementsSchema)
    .then((result) => {
      const statements = limitAnswerStatements(result.statements);
      validateAnswerStatements(statements);
      return { ...result, statements };
    });
  const requirementsPromise = input.invoke(generateAnswerRequirementsPrompt(input.query), answerRequirementsSchema)
    .then((result) => {
      validateAnswerRequirements(result.requirements);
      return result;
    });
  const coherencePromise = input.invoke(
    generateAnswerCoherencePrompt({ query: input.query, finalResult: input.finalResult }),
    answerCoherenceSchema,
  );

  const relevancePromise = statementsPromise.then(async (statementsResult) => {
    if (!statementsResult.statements.length) return null;
    const result = await input.invoke(
      generateStatementRelevancePrompt({
        query: input.query,
        statements: statementsResult.statements.map(({ id, text }) => ({ id, text })),
      }),
      answerRelevanceSchema,
    );
    validateRelevanceVerdicts(statementsResult.statements, result.verdicts);
    return { extraction: statementsResult, judgment: result };
  });

  const completenessPromise = requirementsPromise.then(async (requirementsResult) => {
    if (!requirementsResult.requirements.length) return null;
    const result = await input.invoke(
      generateRequirementCompletenessPrompt({
        requirements: requirementsResult.requirements.map(({ id, text, importance }) => ({ id, text, importance })),
        finalResult: input.finalResult,
      }),
      answerCompletenessSchema,
    );
    validateCompletenessVerdicts(requirementsResult.requirements, result.verdicts);
    return { extraction: requirementsResult, judgment: result };
  });

  const [relevanceResult, completenessResult, coherenceResult] = await Promise.allSettled([
    relevancePromise,
    completenessPromise,
    coherencePromise,
  ]);
  const relevance = unwrapSettled(relevanceResult);
  const completeness = unwrapSettled(completenessResult);
  const coherence = unwrapSettled(coherenceResult);
  if (!relevance || !completeness) {
    const note = !relevance ? '未提取到答案陈述' : '未提取到任务必答要点';
    return {
      score: null,
      confidence: 0,
      note,
      evidence: { reason: note },
    };
  }

  const relevanceScore = scoreAnswerRelevance(relevance.judgment.verdicts, relevance.judgment.noncommittal.value);
  const completenessScore = scoreAnswerCompleteness(completeness.extraction.requirements, completeness.judgment.verdicts);
  if (relevanceScore == null || completenessScore == null) {
    const note = relevanceScore == null ? '答案没有可评估的陈述' : '任务没有可评估的必答要点';
    return { score: null, confidence: 0, note, evidence: { reason: note } };
  }
  const coherenceScore = coherence.rating * 25;
  const score = scoreAnswerQuality({ relevance: relevanceScore, completeness: completenessScore, coherence: coherenceScore });
  const reason = buildAnswerQualityReason({
    requirements: completeness.extraction.requirements,
    completenessVerdicts: completeness.judgment.verdicts,
    relevanceVerdicts: relevance.judgment.verdicts,
    noncommittal: relevance.judgment.noncommittal.value,
    coherence,
  });
  const confidence = Math.min(
    relevance.extraction.confidence,
    relevance.judgment.confidence,
    completeness.extraction.confidence,
    completeness.judgment.confidence,
    coherence.confidence,
  );
  return {
    score,
    confidence,
    evidence: {
      reason,
      subScores: { relevance: relevanceScore, completeness: completenessScore, coherence: coherenceScore },
      relevance: {
        statements: relevance.extraction.statements,
        verdicts: relevance.judgment.verdicts,
        noncommittal: relevance.judgment.noncommittal,
      },
      completeness: {
        requirements: completeness.extraction.requirements,
        verdicts: completeness.judgment.verdicts,
      },
      coherence,
    },
  };
}
