/**
 * Agent 专项评估器共享的 Judge 调用、离散评分、轨迹统计与 Prompt 输入整理工具。
 * 这里只放跨评估器复用的机制；各评估器的 schema、维度和聚合规则留在各自文件。
 */
import type { ZodType } from 'zod';
import type { EvaluatorCapabilityDescriptor } from '@/lib/evaluators/evaluator-case-context';
import {
  normalizeEvaluatorOutput,
  type EvalPointStatus,
  type EvaluatorOutput,
} from '@/lib/evaluators/eval-output';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import type { ToolTraceFacts } from './agent-tool-trace-facts';

export const SPECIALIZED_RUBRIC_VERSION = '1.0.0';

export const VERDICTS = ['met', 'partial', 'missing'] as const;
export type RubricVerdict = (typeof VERDICTS)[number];
export const VERDICT_SCORE: Record<RubricVerdict, 0 | 50 | 100> = {
  met: 100,
  partial: 50,
  missing: 0,
};
export const VERDICT_STATUS: Record<RubricVerdict, EvalPointStatus> = {
  met: 'covered',
  partial: 'partial',
  missing: 'missing',
};

export interface DimensionJudgment<K extends string> {
  dimension: K;
  verdict: RubricVerdict;
  reason: string;
  suggestion: string;
}

interface SpecializedJudgePrompt {
  stage?: string;
  system: string;
  user: string;
}

function parseStructuredJudgeOutput<T>(rawText: string, schema: ZodType<T>): T {
  const text = rawText.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new JudgeOutputParseError('judge 输出中未找到 JSON 对象', rawText);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new JudgeOutputParseError(
      `judge 输出 JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      rawText,
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new JudgeOutputParseError(`judge 输出不符合专项评估器契约: ${details}`, rawText);
  }
  return result.data;
}

export async function invokeSpecializedJudge<T>(
  user: string,
  prompt: SpecializedJudgePrompt,
  schema: ZodType<T>,
): Promise<T> {
  const { callJudgeLlm } = await import('./judge-llm');
  const rawText = await callJudgeLlm(user, {
    system: prompt.system,
    user: prompt.user,
    sessionTitle: `exp-judge-${prompt.stage ?? 'specialized'}`,
  });
  return parseStructuredJudgeOutput(rawText, schema);
}

export function indexCompleteDimensions<K extends string, T extends { dimension: K }>(
  expected: readonly K[],
  judgments: readonly T[],
): Map<K, T> {
  const expectedSet = new Set<string>(expected);
  const byDimension = new Map<K, T>();
  const duplicate = new Set<string>();
  const unexpected = new Set<string>();

  for (const judgment of judgments) {
    if (!expectedSet.has(judgment.dimension)) unexpected.add(judgment.dimension);
    if (byDimension.has(judgment.dimension)) duplicate.add(judgment.dimension);
    byDimension.set(judgment.dimension, judgment);
  }

  const missing = expected.filter((key) => !byDimension.has(key));
  if (missing.length || duplicate.size || unexpected.size || judgments.length !== expected.length) {
    const parts = [
      missing.length ? `缺少 ${missing.join(', ')}` : '',
      duplicate.size ? `重复 ${[...duplicate].join(', ')}` : '',
      unexpected.size ? `未知 ${[...unexpected].join(', ')}` : '',
    ].filter(Boolean);
    throw new JudgeOutputParseError(
      `judge 维度集合不完整: ${parts.join('; ') || `期望 ${expected.length} 项，收到 ${judgments.length} 项`}`,
      JSON.stringify(judgments),
    );
  }
  return byDimension;
}

export function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}

export function scoreDimensions<K extends string>(
  definitions: readonly { key: K; weight: number }[],
  judgments: Map<K, { verdict: RubricVerdict }>,
): number {
  return roundScore(definitions.reduce((sum, definition) => {
    const judgment = judgments.get(definition.key);
    if (!judgment) {
      throw new JudgeOutputParseError(
        `judge 缺少维度 ${definition.key}`,
        JSON.stringify([...judgments.values()]),
      );
    }
    return sum + VERDICT_SCORE[judgment.verdict] * definition.weight;
  }, 0));
}

export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim() ?? '').filter(Boolean))];
}

export function anchorsForStep(stepIndex: number | null): string[] | undefined {
  return typeof stepIndex === 'number' ? [`step-${stepIndex}`] : undefined;
}

export function percentage(numerator: number, denominator: number): number {
  if (denominator === 0) return 100;
  return roundScore((numerator / denominator) * 100);
}

export function percentageOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : roundScore((numerator / denominator) * 100);
}

export function isFailedCallStatus(status: string | null): boolean {
  return Boolean(status && /(fail|error|cancel|timeout)/i.test(status));
}

export function buildTraceCallStatistics(facts: ToolTraceFacts): Record<string, unknown> {
  const counts = Object.values(facts.countsByCapability);
  const total = facts.calls.length;
  const distinct = counts.length;
  const topCount = counts.length ? Math.max(...counts) : 0;
  const concentration = total === 0
    ? null
    : Math.round(counts.reduce((sum, count) => sum + (count / total) ** 2, 0) * 10_000) / 10_000;
  return {
    capabilityCallCount: total,
    distinctCalledCapabilityCount: distinct,
    repeatedCallCount: Math.max(0, total - distinct),
    topCapabilityCallShare: percentageOrNull(topCount, total),
    callConcentrationHhi: concentration,
    failedCallCount: facts.calls.filter((call) => isFailedCallStatus(call.status)).length,
    countsByCapability: facts.countsByCapability,
    unknownCalledCapabilities: facts.unknownCalledCapabilities,
  };
}


export function safePromptValue(value: unknown, maxLength = 2_000): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.slice(0, maxLength);
  try {
    const text = JSON.stringify(value);
    return text.length <= maxLength ? value : `${text.slice(0, maxLength)}…`;
  } catch {
    return String(value).slice(0, maxLength);
  }
}

export function promptCatalog(capabilities: EvaluatorCapabilityDescriptor[]): unknown[] {
  return capabilities.map((capability) => ({
    kind: capability.kind,
    name: capability.name,
    description: capability.description ?? '',
    inputSchema: safePromptValue(capability.inputSchema, 4_000),
  }));
}

export function promptFacts(facts: ToolTraceFacts): unknown[] {
  return facts.calls.slice(0, 160).map((call) => ({
    stepIndex: call.stepIndex,
    capabilityName: call.name,
    kind: call.kind,
    args: safePromptValue(call.args),
    result: safePromptValue(call.result),
    status: call.status,
  }));
}

export function missingToolCatalogOutput(error?: string | null): EvaluatorOutput {
  return normalizeEvaluatorOutput({
    summary: '未提供 Tool/Skill 目录，无法完成工具类评估。',
    evidence: {
      json: {
        rubricVersion: SPECIALIZED_RUBRIC_VERSION,
        unscoredReason: error || '未提供 Tool/Skill 目录，无法判断可用能力、合理闲置或遗漏调用。',
        issues: [],
        suggestions: ['为 case 提供 evaluatorContext.availableTools（及可选 availableSkills）后重评。'],
      },
    },
  });
}
