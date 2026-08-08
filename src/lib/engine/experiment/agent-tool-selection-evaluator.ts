/**
 * “Agent 工具选择合理性”预置评估器。
 *
 * Judge Prompt：src/prompts/agent-tool-selection-prompt.ts
 *
 * 算法：
 * 1. 仅评价 Tool/Skill；Judge 对工具必要性、工具-任务匹配度、参数合理性、结果利用率、
 *    调用顺序合理性分别给出 met/partial/missing，并将问题定位到目录能力或真实调用步骤。
 * 2. 档位映射：met=100、partial=50、missing=0；五维各占 20%，
 *    基础分 = Σ(维度档位分×20%)。
 * 3. 只有经代码校验、能落到显式目录或真实 step 的问题才参与严重问题封顶：
 *    遗漏必要工具封顶 20，关键参数幻觉封顶 40，核心工具选错、忽略关键结果、
 *    依赖顺序错误分别封顶 50。
 * 4. 总分 = min(基础分, 所有已触发封顶值中的最小值)；没有封顶问题时总分=基础分，
 *    最终限制在 0–100。
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
import {
  AGENT_TOOL_SELECTION_DIMENSION_KEYS,
  AGENT_TOOL_SELECTION_DIMENSIONS,
  AGENT_TOOL_SELECTION_ISSUE_CODES,
  generateAgentToolSelectionPrompt,
  type AgentToolSelectionDimension,
  type AgentToolSelectionIssueCode,
} from '@/prompts/agent-tool-selection-prompt';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { extractToolTraceFacts, type ToolTraceFacts } from './agent-tool-trace-facts';
import {
  SPECIALIZED_RUBRIC_VERSION,
  VERDICTS,
  VERDICT_SCORE,
  VERDICT_STATUS,
  anchorsForStep,
  buildTraceCallStatistics,
  indexCompleteDimensions,
  invokeSpecializedJudge,
  missingToolCatalogOutput,
  promptCatalog,
  promptFacts,
  scoreDimensions,
  uniqueStrings,
  type DimensionJudgment,
} from './specialized-evaluator-common';

export const TOOL_SELECTION_PRESET_ID = 'preset-agent-tool-selection' as const;

const SELECTION_DIMENSIONS = AGENT_TOOL_SELECTION_DIMENSIONS;
const SELECTION_KEYS = AGENT_TOOL_SELECTION_DIMENSION_KEYS;
export type SelectionDimension = AgentToolSelectionDimension;

export const SELECTION_ISSUE_CODES = AGENT_TOOL_SELECTION_ISSUE_CODES;
export type SelectionIssueCode = AgentToolSelectionIssueCode;

export interface SelectionIssue {
  code: SelectionIssueCode;
  severity: 'minor' | 'major' | 'critical';
  dimension: SelectionDimension;
  capabilityKind: EvaluatorCapabilityKind;
  toolName: string;
  stepIndex: number | null;
  reason: string;
  suggestion: string;
}

export interface SelectionJudgeResult {
  summary?: string;
  dimensions: Array<DimensionJudgment<SelectionDimension>>;
  issues?: SelectionIssue[];
  suggestions?: string[];
}

const dimensionSchema = z.object({
  dimension: z.enum(SELECTION_KEYS),
  verdict: z.enum(VERDICTS),
  reason: z.string().trim().min(1),
  suggestion: z.string(),
}).superRefine((value, ctx) => {
  if (value.verdict !== 'met' && !value.suggestion.trim()) {
    ctx.addIssue({ code: 'custom', path: ['suggestion'], message: 'partial/missing 必须提供改进建议' });
  }
});

const selectionIssueSchema = z.object({
  code: z.enum(SELECTION_ISSUE_CODES),
  severity: z.enum(['minor', 'major', 'critical']),
  dimension: z.enum(SELECTION_KEYS),
  capabilityKind: z.enum(['tool', 'skill']),
  toolName: z.string().trim().min(1),
  stepIndex: z.number().int().nonnegative().nullable(),
  reason: z.string().trim().min(1),
  suggestion: z.string().trim().min(1),
});

const selectionJudgeSchema = z.object({
  summary: z.string().trim().min(1).max(200).optional(),
  dimensions: z.array(dimensionSchema).length(SELECTION_KEYS.length),
  issues: z.array(selectionIssueSchema).default([]),
  suggestions: z.array(z.string()).default([]),
});

const SELECTION_CAPS: Partial<Record<SelectionIssueCode, number>> = {
  missing_required_tool: 20,
  hallucinated_critical_argument: 40,
  wrong_core_tool: 50,
  ignored_key_result: 50,
  dependency_order_violation: 50,
};

const SELECTION_CAP_LABELS: Partial<Record<SelectionIssueCode, string>> = {
  missing_required_tool: '遗漏必要 Tool/Skill',
  hallucinated_critical_argument: '关键参数缺少依据',
  wrong_core_tool: '核心 Tool/Skill 选择错误',
  ignored_key_result: '忽略关键调用结果',
  dependency_order_violation: '依赖调用顺序错误',
};

const SELECTION_CALL_ISSUE_CODES = new Set<SelectionIssueCode>([
  'hallucinated_critical_argument',
  'wrong_core_tool',
  'ignored_key_result',
  'dependency_order_violation',
  'irrelevant_call',
  'redundant_call',
  'invalid_argument',
]);

const SELECTION_ISSUE_DIMENSIONS: Partial<Record<SelectionIssueCode, SelectionDimension>> = {
  missing_required_tool: 'tool_necessity',
  hallucinated_critical_argument: 'parameter_validity',
  wrong_core_tool: 'tool_match',
  ignored_key_result: 'result_utilization',
  dependency_order_violation: 'call_order',
  irrelevant_call: 'tool_necessity',
  redundant_call: 'tool_necessity',
  invalid_argument: 'parameter_validity',
};

interface DiscardedSelectionIssue extends SelectionIssue {
  discardReason: string;
}

function groundSelectionJudgeIssues(input: {
  availableCapabilities: EvaluatorCapabilityDescriptor[];
  facts: ToolTraceFacts;
  issues: SelectionIssue[];
}): { issues: SelectionIssue[]; discarded: DiscardedSelectionIssue[] } {
  const catalogByKey = new Map(input.availableCapabilities.map((capability) => [
    canonicalCapabilityKey(capability.kind, capability.name),
    capability,
  ]));
  const callsByStep = new Map(input.facts.calls.map((call) => [call.stepIndex, call]));
  const issues: SelectionIssue[] = [];
  const discarded: DiscardedSelectionIssue[] = [];

  for (const rawIssue of input.issues) {
    const issue = {
      ...rawIssue,
      dimension: SELECTION_ISSUE_DIMENSIONS[rawIssue.code] ?? rawIssue.dimension,
    };
    if (issue.code === 'missing_required_tool') {
      const capability = catalogByKey.get(canonicalCapabilityKey(issue.capabilityKind, issue.toolName));
      if (!capability) {
        discarded.push({ ...issue, discardReason: '遗漏能力不在显式 Tool/Skill 目录中。' });
        continue;
      }
      issues.push({
        ...issue,
        capabilityKind: capability.kind,
        toolName: capability.name,
        stepIndex: null,
      });
      continue;
    }

    if (SELECTION_CALL_ISSUE_CODES.has(issue.code)) {
      const call = typeof issue.stepIndex === 'number' ? callsByStep.get(issue.stepIndex) : undefined;
      if (!call) {
        discarded.push({ ...issue, discardReason: '问题未定位到真实 Tool/Skill 调用步骤。' });
        continue;
      }
      issues.push({
        ...issue,
        capabilityKind: call.kind,
        toolName: call.name,
        stepIndex: call.stepIndex,
      });
      continue;
    }

    if (typeof issue.stepIndex === 'number') {
      const call = callsByStep.get(issue.stepIndex);
      if (!call) {
        discarded.push({ ...issue, discardReason: '问题引用的调用步骤不存在。' });
        continue;
      }
      issues.push({ ...issue, capabilityKind: call.kind, toolName: call.name });
      continue;
    }
    issues.push(issue);
  }

  return { issues, discarded };
}

export function buildSelectionEvaluatorOutput(input: {
  availableCapabilities: EvaluatorCapabilityDescriptor[];
  facts: ToolTraceFacts;
  judgment: SelectionJudgeResult;
}): EvaluatorOutput {
  const byDimension = indexCompleteDimensions(SELECTION_KEYS, input.judgment.dimensions);
  const groundedJudgeIssues = groundSelectionJudgeIssues({
    availableCapabilities: input.availableCapabilities,
    facts: input.facts,
    issues: input.judgment.issues ?? [],
  });
  const issueKeys = new Set<string>();
  const issues = groundedJudgeIssues.issues.filter((issue) => {
    const key = [issue.code, issue.dimension, issue.capabilityKind, issue.toolName.toLowerCase(), issue.stepIndex].join(':');
    if (issueKeys.has(key)) return false;
    issueKeys.add(key);
    return true;
  });
  const caps = issues.flatMap((issue) => {
    const value = SELECTION_CAPS[issue.code];
    return typeof value === 'number' ? [{ value, issue }] : [];
  });
  const applied = caps.length
    ? caps.reduce((lowest, current) => current.value < lowest.value ? current : lowest)
    : null;
  const baseScore = scoreDimensions(SELECTION_DIMENSIONS, byDimension);
  const score = applied ? Math.min(baseScore, applied.value) : baseScore;
  const capSummary = applied
    ? `${SELECTION_CAP_LABELS[applied.issue.code] ?? applied.issue.code}：${applied.issue.reason}`
      + `（${applied.issue.toolName}${typeof applied.issue.stepIndex === 'number' ? `，step-${applied.issue.stepIndex}` : ''}）。`
      + `总分由基础分 ${baseScore} 分封顶为 ${applied.value} 分。`
    : null;
  const points: EvalPoint[] = SELECTION_DIMENSIONS.map((definition) => {
    const judgment = byDimension.get(definition.key)!;
    const relatedIssues = issues.filter((issue) => issue.dimension === definition.key);
    return {
      label: definition.label,
      score: VERDICT_SCORE[judgment.verdict],
      status: VERDICT_STATUS[judgment.verdict],
      evidence: {
        json: {
          verdict: judgment.verdict,
          reason: judgment.reason,
          issues: relatedIssues,
        },
      },
      suggestion: judgment.suggestion || relatedIssues.find((issue) => issue.suggestion)?.suggestion || undefined,
      anchors: uniqueStrings(relatedIssues.flatMap((issue) => anchorsForStep(issue.stepIndex) ?? [])),
    };
  });
  if (capSummary) {
    points.push({
      label: '总分封顶说明',
      evidence: { md: capSummary },
      anchors: anchorsForStep(applied?.issue.stepIndex ?? null),
    });
  }
  const suggestions = uniqueStrings([
    ...issues.map((issue) => issue.suggestion),
    ...SELECTION_DIMENSIONS.map((definition) => byDimension.get(definition.key)?.suggestion),
  ]);
  const verdictCount = (verdict: 'met' | 'partial' | 'missing') => SELECTION_DIMENSIONS.filter(
    (definition) => byDimension.get(definition.key)?.verdict === verdict,
  ).length;
  const fallbackSummary = `工具选择的 ${SELECTION_DIMENSIONS.length} 个维度中，达成 ${verdictCount('met')} 项、部分达成 ${verdictCount('partial')} 项、未达成 ${verdictCount('missing')} 项。${applied ? '已按严重问题规则限制总分。' : ''}`;
  const summary = input.judgment.summary?.trim() || fallbackSummary;
  return normalizeEvaluatorOutput({
    score,
    summary,
    points,
    evidence: {
      json: {
        rubricVersion: SPECIALIZED_RUBRIC_VERSION,
        dimensions: SELECTION_DIMENSIONS.map((definition) => {
          const judgment = byDimension.get(definition.key)!;
          return {
            key: definition.key,
            verdict: judgment.verdict,
            score: VERDICT_SCORE[judgment.verdict],
            reason: judgment.reason,
          };
        }),
        statistics: {
          ...buildTraceCallStatistics(input.facts),
          discardedJudgeIssues: groundedJudgeIssues.discarded,
        },
        issues,
        suggestions,
        ...(applied ? {
          appliedCap: {
            value: applied.value,
            reason: `${applied.issue.code}: ${applied.issue.reason}`,
            summary: capSummary,
          },
        } : {}),
      },
    },
  });
}


function selectionPrompt(
  ctx: FaithfulPresetContext,
  capabilities: EvaluatorCapabilityDescriptor[],
  facts: ToolTraceFacts,
) {
  return generateAgentToolSelectionPrompt({
    query: ctx.caseInput,
    actualOutput: ctx.actualOutput,
    capabilityCatalog: promptCatalog(capabilities),
    calls: promptFacts(facts),
    statistics: buildTraceCallStatistics(facts),
  });
}

export async function runToolSelectionPreset(
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  if (!ctx.evaluatorContext) return missingToolCatalogOutput(ctx.evaluatorContextError);
  const capabilities = listEvaluatorCapabilities(ctx.evaluatorContext);
  const facts = extractToolTraceFacts(ctx.interactions, capabilities);
  const judgment = await invokeSpecializedJudge(
    user,
    selectionPrompt(ctx, capabilities, facts),
    selectionJudgeSchema,
  );
  return buildSelectionEvaluatorOutput({ availableCapabilities: capabilities, facts, judgment });
}
