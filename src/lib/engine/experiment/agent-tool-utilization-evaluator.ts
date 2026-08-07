/**
 * “轨迹工具利用率”预置评估器。
 *
 * Judge Prompt：src/prompts/agent-tool-utilization-prompt.ts
 *
 * 算法：
 * 1. 只统计 Tool/Skill 调用，不统计 Agent、子 Agent 或任务委派。Judge 按目录把能力分类为
 *    required、optional、irrelevant，分类不得由是否调用反推。
 * 2. 必要能力覆盖率 = 已调用 required 能力数 ÷ required 能力总数；无 required 能力时为 N/A。
 * 3. 调用匹配率 = required/optional 调用次数 ÷ 全部 Tool/Skill 调用次数；无调用时为 N/A。
 * 4. 调用节制率 = 有效 required/optional 调用次数 ÷ required/optional 调用次数。Judge 只为
 *    redundant/ineffective 调用提供负向事实；其余相关调用视为有效。
 * 5. 总分 = 50% × 必要能力覆盖率 + 25% × 调用匹配率 + 25% × 调用节制率；N/A 权重重归一。
 *    无 required 能力且没有调用表示合理闲置，得 100。一个调用只影响一个比例。
 */
import { z } from 'zod';
import {
  canonicalCapabilityKey,
  listEvaluatorCapabilities,
  type EvaluatorCapabilityDescriptor,
  type EvaluatorCapabilityKind,
} from '@/lib/evaluators/evaluator-case-context';
import {
  normalizeEvaluatorOutput,
  type EvalPoint,
  type EvaluatorOutput,
} from '@/lib/evaluators/eval-output';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import {
  AGENT_TOOL_UTILIZATION_DIMENSIONS,
  generateAgentToolUtilizationPrompt,
  type AgentToolUtilizationDimension,
} from '@/prompts/agent-tool-utilization-prompt';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { extractToolTraceFacts, type ToolTraceFacts } from './agent-tool-trace-facts';
import {
  SPECIALIZED_RUBRIC_VERSION,
  anchorsForStep,
  buildTraceCallStatistics,
  invokeSpecializedJudge,
  missingToolCatalogOutput,
  percentageOrNull,
  promptCatalog,
  promptFacts,
  roundScore,
  uniqueStrings,
} from './specialized-evaluator-common';

export const TOOL_UTILIZATION_PRESET_ID = 'preset-agent-tool-utilization' as const;

const UTILIZATION_DIMENSIONS = AGENT_TOOL_UTILIZATION_DIMENSIONS;
export type UtilizationDimension = AgentToolUtilizationDimension;
export type CapabilityRelevance = 'required' | 'optional' | 'irrelevant';
export type UtilizationCallFindingClassification =
  | 'out_of_catalog'
  | 'irrelevant'
  | 'redundant'
  | 'ineffective';

export interface CapabilityRelevanceJudgment {
  kind: EvaluatorCapabilityKind;
  name: string;
  relevance: CapabilityRelevance;
  reason: string;
  idleReason: string;
}

interface CapabilityClassificationEvidence {
  kind: EvaluatorCapabilityKind;
  name: string;
  relevance: CapabilityRelevance;
  called: boolean;
  reason: string;
  idleReason: string;
}

export interface UtilizationCallFinding {
  stepIndex: number;
  classification: UtilizationCallFindingClassification;
  reason: string;
  suggestion: string;
}

export interface UtilizationJudgeResult {
  summary?: string;
  capabilities: CapabilityRelevanceJudgment[];
  callFindings?: UtilizationCallFinding[];
  suggestions?: string[];
}

interface GroundedUtilizationCallFinding extends UtilizationCallFinding {
  capabilityKind: EvaluatorCapabilityKind;
  toolName: string;
  affects: UtilizationDimension;
}

interface UtilizationMetricResult {
  key: UtilizationDimension;
  label: string;
  weight: number;
  numerator: number | null;
  denominator: number | null;
  score: number | null;
  reason: string;
  issues: GroundedUtilizationCallFinding[];
}

const utilizationCallFindingSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  classification: z.enum(['out_of_catalog', 'irrelevant', 'redundant', 'ineffective']),
  reason: z.string().trim().min(1),
  suggestion: z.string().trim().min(1),
});

const utilizationJudgeSchema = z.object({
  summary: z.string().trim().min(1).max(200).optional(),
  capabilities: z.array(z.object({
    kind: z.enum(['tool', 'skill']),
    name: z.string().min(1),
    relevance: z.enum(['required', 'optional', 'irrelevant']),
    reason: z.string().trim().min(1),
    idleReason: z.string(),
  })),
  callFindings: z.array(utilizationCallFindingSchema).default([]),
  suggestions: z.array(z.string()).default([]),
});

function normalizeCapabilityJudgments(
  availableCapabilities: EvaluatorCapabilityDescriptor[],
  judgments: CapabilityRelevanceJudgment[],
): CapabilityRelevanceJudgment[] {
  const availableByKey = new Map(availableCapabilities.map((capability) => [
    canonicalCapabilityKey(capability.kind, capability.name),
    capability,
  ]));
  const byKey = new Map<string, CapabilityRelevanceJudgment>();
  const duplicate = new Set<string>();
  const unexpected = new Set<string>();
  for (const judgment of judgments) {
    const key = canonicalCapabilityKey(judgment.kind, judgment.name);
    if (!availableByKey.has(key)) unexpected.add(`${judgment.kind}:${judgment.name}`);
    if (byKey.has(key)) duplicate.add(`${judgment.kind}:${judgment.name}`);
    byKey.set(key, judgment);
  }
  const missing = availableCapabilities.filter((capability) => (
    !byKey.has(canonicalCapabilityKey(capability.kind, capability.name))
  ));
  if (missing.length || duplicate.size || unexpected.size || judgments.length !== availableCapabilities.length) {
    const parts = [
      missing.length ? `缺少 ${missing.map((item) => `${item.kind}:${item.name}`).join(', ')}` : '',
      duplicate.size ? `重复 ${[...duplicate].join(', ')}` : '',
      unexpected.size ? `目录外 ${[...unexpected].join(', ')}` : '',
    ].filter(Boolean);
    throw new JudgeOutputParseError(
      `judge 能力相关性列表与目录不一致: ${parts.join('; ') || `期望 ${availableCapabilities.length} 项，收到 ${judgments.length} 项`}`,
      JSON.stringify(judgments),
    );
  }
  return availableCapabilities.map((capability) => (
    byKey.get(canonicalCapabilityKey(capability.kind, capability.name))!
  ));
}

function callFindingMetric(classification: UtilizationCallFindingClassification): UtilizationDimension {
  return classification === 'out_of_catalog' || classification === 'irrelevant'
    ? 'call_match_rate'
    : 'call_restraint_rate';
}

function groundCallFindings(input: {
  facts: ToolTraceFacts;
  capabilityJudgments: CapabilityRelevanceJudgment[];
  findings: UtilizationCallFinding[];
}): GroundedUtilizationCallFinding[] {
  const callsByStep = new Map(input.facts.calls.map((call) => [call.stepIndex, call]));
  const relevanceByKey = new Map(input.capabilityJudgments.map((capability) => [
    canonicalCapabilityKey(capability.kind, capability.name),
    capability.relevance,
  ]));
  const grounded: GroundedUtilizationCallFinding[] = [];
  const seenSteps = new Set<number>();

  for (const finding of input.findings) {
    if (seenSteps.has(finding.stepIndex)) {
      throw new JudgeOutputParseError(`judge 为 step-${finding.stepIndex} 输出了重复的调用判断`, JSON.stringify(input.findings));
    }
    seenSteps.add(finding.stepIndex);
    const call = callsByStep.get(finding.stepIndex);
    if (!call) {
      throw new JudgeOutputParseError(`judge 问题未定位到真实 Tool/Skill 调用 step-${finding.stepIndex}`, JSON.stringify(input.findings));
    }
    const relevance = relevanceByKey.get(call.canonicalKey);
    const compatible = (
      (finding.classification === 'out_of_catalog' && relevance === undefined)
      || (finding.classification === 'irrelevant' && relevance === 'irrelevant')
      || ((finding.classification === 'redundant' || finding.classification === 'ineffective')
        && (relevance === 'required' || relevance === 'optional'))
    );
    if (!compatible) {
      throw new JudgeOutputParseError(
        `judge 对 step-${finding.stepIndex} 的 ${finding.classification} 分类与目录能力相关性不一致`,
        JSON.stringify(input.findings),
      );
    }
    grounded.push({
      ...finding,
      capabilityKind: call.kind,
      toolName: call.name,
      affects: callFindingMetric(finding.classification),
    });
  }

  return grounded;
}

function rateStatus(score: number | null): 'covered' | 'partial' | 'missing' | undefined {
  if (score === null) return undefined;
  if (score === 100) return 'covered';
  if (score === 0) return 'missing';
  return 'partial';
}

function rateVerdict(score: number | null): 'met' | 'partial' | 'missing' | 'not_applicable' {
  if (score === null) return 'not_applicable';
  if (score === 100) return 'met';
  if (score === 0) return 'missing';
  return 'partial';
}

function rateText(score: number | null): string {
  return score === null ? '不适用' : `${score}%`;
}

/** 按有效维度权重重归一聚合 0–100 比例；全部不适用仅用于“无需能力且无调用”场景。 */
export function aggregateUtilizationRates(rates: Record<UtilizationDimension, number | null>): number {
  const active = UTILIZATION_DIMENSIONS.filter((definition) => rates[definition.key] !== null);
  if (!active.length) return 100;
  const activeWeight = active.reduce((sum, definition) => sum + definition.weight, 0);
  return roundScore(active.reduce(
    (sum, definition) => sum + (rates[definition.key] ?? 0) * definition.weight,
    0,
  ) / activeWeight);
}

function describeUnusedRequired(capabilities: CapabilityRelevanceJudgment[]): string {
  return capabilities
    .map((capability) => `${capability.kind}:${capability.name}（${capability.idleReason || capability.reason}）`)
    .join('；');
}

export function buildUtilizationEvaluatorOutput(input: {
  availableCapabilities: EvaluatorCapabilityDescriptor[];
  facts: ToolTraceFacts;
  judgment: UtilizationJudgeResult;
}): EvaluatorOutput {
  const capabilityJudgments = normalizeCapabilityJudgments(input.availableCapabilities, input.judgment.capabilities ?? []);
  const relevanceByKey = new Map(capabilityJudgments.map((capability) => [
    canonicalCapabilityKey(capability.kind, capability.name),
    capability.relevance,
  ]));
  const calledCapabilities = new Set(input.facts.calls.map((call) => call.canonicalKey));
  const required = capabilityJudgments.filter((capability) => capability.relevance === 'required');
  const optional = capabilityJudgments.filter((capability) => capability.relevance === 'optional');
  const irrelevant = capabilityJudgments.filter((capability) => capability.relevance === 'irrelevant');
  const calledRequired = required.filter((capability) => calledCapabilities.has(
    canonicalCapabilityKey(capability.kind, capability.name),
  ));
  const unusedRequired = required.filter((capability) => !calledCapabilities.has(
    canonicalCapabilityKey(capability.kind, capability.name),
  ));
  const capabilityClassifications: CapabilityClassificationEvidence[] = capabilityJudgments.map((capability) => ({
    kind: capability.kind,
    name: capability.name,
    relevance: capability.relevance,
    called: calledCapabilities.has(canonicalCapabilityKey(capability.kind, capability.name)),
    reason: capability.reason,
    idleReason: capability.idleReason,
  }));
  const groundedFindings = groundCallFindings({
    facts: input.facts,
    capabilityJudgments,
    findings: input.judgment.callFindings ?? [],
  });
  const relatedCalls = input.facts.calls.filter((call) => {
    const relevance = relevanceByKey.get(call.canonicalKey);
    return relevance === 'required' || relevance === 'optional';
  });
  const nonEffectiveSteps = new Set(
    groundedFindings
      .filter((finding) => finding.affects === 'call_restraint_rate')
      .map((finding) => finding.stepIndex),
  );
  const effectiveRelatedCalls = relatedCalls.filter((call) => !nonEffectiveSteps.has(call.stepIndex));
  const requiredCapabilityCoverage = percentageOrNull(calledRequired.length, required.length);
  const callMatchRate = percentageOrNull(relatedCalls.length, input.facts.calls.length);
  const callRestraintRate = percentageOrNull(effectiveRelatedCalls.length, relatedCalls.length);
  const rates: Record<UtilizationDimension, number | null> = {
    required_capability_coverage: requiredCapabilityCoverage,
    call_match_rate: callMatchRate,
    call_restraint_rate: callRestraintRate,
  };
  const score = required.length === 0 && input.facts.calls.length === 0
    ? 100
    : aggregateUtilizationRates(rates);
  const matchFindings = groundedFindings.filter((finding) => finding.affects === 'call_match_rate');
  const restraintFindings = groundedFindings.filter((finding) => finding.affects === 'call_restraint_rate');
  const metrics: UtilizationMetricResult[] = [
    {
      key: 'required_capability_coverage',
      label: '必要能力覆盖率',
      weight: 0.5,
      numerator: requiredCapabilityCoverage === null ? null : calledRequired.length,
      denominator: requiredCapabilityCoverage === null ? null : required.length,
      score: requiredCapabilityCoverage,
      reason: requiredCapabilityCoverage === null
        ? '目录中没有能力被标记为必要，本维度不适用。'
        : unusedRequired.length
          ? `必要能力 ${required.length} 项，已调用 ${calledRequired.length} 项；未覆盖：${describeUnusedRequired(unusedRequired)}。`
          : `目录中标记为必要的 ${required.length} 项能力均至少调用一次。`,
      issues: [],
    },
    {
      key: 'call_match_rate',
      label: '调用匹配率',
      weight: 0.25,
      numerator: callMatchRate === null ? null : relatedCalls.length,
      denominator: callMatchRate === null ? null : input.facts.calls.length,
      score: callMatchRate,
      reason: callMatchRate === null
        ? '轨迹没有 Tool/Skill 调用，本维度不适用。'
        : matchFindings.length
          ? `全部 ${input.facts.calls.length} 次调用中，有 ${relatedCalls.length} 次对应必要或可选能力；${matchFindings.map((finding) => finding.reason).join('；')}`
          : `全部 ${input.facts.calls.length} 次调用均对应目录中标记为必要或可选的能力。`,
      issues: matchFindings,
    },
    {
      key: 'call_restraint_rate',
      label: '调用节制率',
      weight: 0.25,
      numerator: callRestraintRate === null ? null : effectiveRelatedCalls.length,
      denominator: callRestraintRate === null ? null : relatedCalls.length,
      score: callRestraintRate,
      reason: callRestraintRate === null
        ? '没有调用必要或可选能力，本维度不适用。'
        : restraintFindings.length
          ? `必要或可选能力调用 ${relatedCalls.length} 次，其中 ${effectiveRelatedCalls.length} 次有效；${restraintFindings.map((finding) => finding.reason).join('；')}`
          : `必要或可选能力共调用 ${relatedCalls.length} 次，未发现冗余或无效调用。`,
      issues: restraintFindings,
    },
  ];
  const issues = groundedFindings.map((finding) => ({
    code: finding.classification,
    dimension: finding.affects,
    capabilityKind: finding.capabilityKind,
    toolName: finding.toolName,
    stepIndex: finding.stepIndex,
    reason: finding.reason,
    suggestion: finding.suggestion,
  }));
  const unusedCapabilities = capabilityJudgments.filter((capability) => !calledCapabilities.has(
    canonicalCapabilityKey(capability.kind, capability.name),
  ));
  const callCountsByRelevance = { required: 0, optional: 0, irrelevant: 0, unknown: 0 };
  for (const call of input.facts.calls) {
    const relevance = relevanceByKey.get(call.canonicalKey);
    if (relevance) callCountsByRelevance[relevance] += 1;
    else callCountsByRelevance.unknown += 1;
  }
  const statistics = {
    ...buildTraceCallStatistics(input.facts),
    catalogCapabilityCount: input.availableCapabilities.length,
    requiredCapabilityCount: required.length,
    optionalCapabilityCount: optional.length,
    irrelevantCapabilityCount: irrelevant.length,
    calledRequiredCapabilityCount: calledRequired.length,
    requiredCapabilityCoverage,
    totalCallCount: input.facts.calls.length,
    matchedCallCount: relatedCalls.length,
    callMatchRate,
    relatedCallCount: relatedCalls.length,
    effectiveRelatedCallCount: effectiveRelatedCalls.length,
    callRestraintRate,
    callCountsByRelevance,
    unusedCapabilities: unusedCapabilities.map((capability) => ({
      kind: capability.kind,
      name: capability.name,
      relevance: capability.relevance,
      reason: capability.idleReason || capability.reason,
    })),
  };
  const points: EvalPoint[] = metrics.map((metric) => ({
    label: metric.label,
    score: metric.score ?? undefined,
    status: rateStatus(metric.score),
    evidence: {
      json: {
        verdict: rateVerdict(metric.score),
        score: metric.score,
        numerator: metric.numerator,
        denominator: metric.denominator,
        reason: metric.reason,
        issues: metric.issues,
        ...(metric.key === 'required_capability_coverage' ? { capabilityClassifications } : {}),
      },
    },
    suggestion: metric.issues.find((issue) => issue.suggestion)?.suggestion,
    anchors: uniqueStrings(metric.issues.flatMap((issue) => anchorsForStep(issue.stepIndex) ?? [])),
  }));
  const suggestions = uniqueStrings([
    ...issues.map((issue) => issue.suggestion),
    ...(input.judgment.suggestions ?? []),
  ]);
  const fallbackSummary = required.length === 0 && input.facts.calls.length === 0
    ? '任务没有必要 Tool/Skill，且轨迹没有调用；目录能力合理闲置，综合得分 100 分。'
    : `必要能力覆盖率 ${rateText(requiredCapabilityCoverage)}；调用匹配率 ${rateText(callMatchRate)}；调用节制率 ${rateText(callRestraintRate)}；综合 ${score} 分。`;
  const summary = input.judgment.summary?.trim() || fallbackSummary;
  return normalizeEvaluatorOutput({
    score,
    summary,
    points,
    evidence: {
      json: {
        rubricVersion: SPECIALIZED_RUBRIC_VERSION,
        dimensions: metrics.map((metric) => ({
          key: metric.key,
          score: metric.score,
          numerator: metric.numerator,
          denominator: metric.denominator,
          weight: metric.weight,
          verdict: rateVerdict(metric.score),
          reason: metric.reason,
        })),
        capabilityClassifications,
        statistics,
        issues,
        suggestions,
      },
    },
  });
}

function utilizationPrompt(
  ctx: FaithfulPresetContext,
  capabilities: EvaluatorCapabilityDescriptor[],
  facts: ToolTraceFacts,
) {
  return generateAgentToolUtilizationPrompt({
    query: ctx.caseInput,
    actualOutput: ctx.actualOutput,
    capabilityCatalog: promptCatalog(capabilities),
    calls: promptFacts(facts),
    statistics: buildTraceCallStatistics(facts),
  });
}

export async function runToolUtilizationPreset(
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  if (!ctx.evaluatorContext) return missingToolCatalogOutput(ctx.evaluatorContextError);
  const capabilities = listEvaluatorCapabilities(ctx.evaluatorContext);
  const facts = extractToolTraceFacts(ctx.interactions, capabilities);
  const judgment = await invokeSpecializedJudge(
    user,
    utilizationPrompt(ctx, capabilities, facts),
    utilizationJudgeSchema,
  );
  return buildUtilizationEvaluatorOutput({ availableCapabilities: capabilities, facts, judgment });
}
