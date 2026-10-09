import { z } from 'zod';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import {
  compareAgentTrajectoryStepTemporalOrder,
  type AgentTrajectoryFacts,
} from './agent-trajectory-facts';

export type AgentTrajectoryEvaluatorKind = 'step-efficiency' | 'process-quality';
export type AgentTrajectoryVerdict = 'met' | 'partial' | 'missing';

export interface AgentTrajectoryDimensionResult {
  dimension: string;
  verdict: AgentTrajectoryVerdict;
  reason: string;
  suggestion: string;
  rawScore: number;
  score: number;
  status: 'covered' | 'partial' | 'missing';
  anchors: string[];
}

export interface GroundedTrajectoryIssue {
  code: AgentTrajectoryIssueCode;
  severity: 'minor' | 'major' | 'critical';
  dimension: string;
  stepIndexes: number[];
  toolName?: string;
  reason: string;
  suggestion: string;
}

export interface DiscardedTrajectoryIssue extends GroundedTrajectoryIssue {
  discardReason: string;
}

export interface AppliedTrajectoryCap {
  code: AgentTrajectoryIssueCode;
  scope: 'dimension' | 'additional-dimension' | 'total';
  dimension: string;
  cap: number;
}

export interface AgentTrajectoryAssessment {
  kind: AgentTrajectoryEvaluatorKind;
  rubricVersion: 'agent-step-efficiency/1.0.0' | 'agent-process-quality/1.0.0';
  summary: string;
  score: number;
  baseScore: number;
  dimensions: AgentTrajectoryDimensionResult[];
  issues: GroundedTrajectoryIssue[];
  discardedIssues: DiscardedTrajectoryIssue[];
  appliedCaps: AppliedTrajectoryCap[];
  factsSummary: Record<string, unknown>;
}

const EFFICIENCY_DIMENSIONS = [
  'step_necessity',
  'path_detour',
  'cost_efficiency',
  'step_density',
  'retry_efficiency',
] as const;

const QUALITY_DIMENSIONS = [
  'goal_alignment',
  'planning_completeness',
  'reasoning_coherence',
  'exception_handling',
  'path_robustness',
  'information_utilization',
] as const;

const ISSUE_CODES = [
  'duplicate_no_gain',
  'irrelevant_detour',
  'unchanged_retry_loop',
  'avoidable_llm_overuse',
  'fragmented_mergeable_steps',
  'excessive_detour',
  'unused_tool_result_processing',
  'overrollback',
  'goal_drift',
  'missing_required_step',
  'unsupported_reasoning_jump',
  'unhandled_recoverable_error',
  'contradicted_tool_result',
  'decision_thrashing',
  'internal_contradiction',
  'unused_required_information',
] as const;

export type AgentTrajectoryIssueCode = (typeof ISSUE_CODES)[number];

interface IssueRule {
  dimension: string;
  dimensionCap: number;
  totalCap: number;
  additionalDimensionCap?: { dimension: string; cap: number };
  deterministicCandidate?: keyof AgentTrajectoryFacts['candidates'];
  minimumStepCount?: number;
}

const ISSUE_RULES: Record<AgentTrajectoryIssueCode, IssueRule> = {
  duplicate_no_gain: { dimension: 'step_necessity', dimensionCap: 40, totalCap: 50, deterministicCandidate: 'repeatedSameResultCandidates', minimumStepCount: 3 },
  irrelevant_detour: { dimension: 'path_detour', dimensionCap: 30, totalCap: 40 },
  unchanged_retry_loop: { dimension: 'retry_efficiency', dimensionCap: 20, totalCap: 40, deterministicCandidate: 'unchangedRetryCandidates' },
  avoidable_llm_overuse: { dimension: 'cost_efficiency', dimensionCap: 30, totalCap: 50 },
  fragmented_mergeable_steps: { dimension: 'step_density', dimensionCap: 50, totalCap: 60, deterministicCandidate: 'consecutiveSimilarCandidates', minimumStepCount: 3 },
  excessive_detour: {
    dimension: 'path_detour',
    dimensionCap: 20,
    totalCap: 30,
    additionalDimensionCap: { dimension: 'step_necessity', cap: 30 },
    minimumStepCount: 3,
  },
  unused_tool_result_processing: { dimension: 'cost_efficiency', dimensionCap: 30, totalCap: 50, minimumStepCount: 3 },
  overrollback: { dimension: 'retry_efficiency', dimensionCap: 20, totalCap: 40, minimumStepCount: 3 },
  goal_drift: { dimension: 'goal_alignment', dimensionCap: 40, totalCap: 50 },
  missing_required_step: { dimension: 'planning_completeness', dimensionCap: 30, totalCap: 50 },
  unsupported_reasoning_jump: { dimension: 'reasoning_coherence', dimensionCap: 40, totalCap: 50 },
  unhandled_recoverable_error: { dimension: 'exception_handling', dimensionCap: 30, totalCap: 40 },
  contradicted_tool_result: { dimension: 'information_utilization', dimensionCap: 30, totalCap: 50, minimumStepCount: 2 },
  decision_thrashing: { dimension: 'path_robustness', dimensionCap: 30, totalCap: 40, minimumStepCount: 3 },
  internal_contradiction: { dimension: 'reasoning_coherence', dimensionCap: 30, totalCap: 40, minimumStepCount: 2 },
  unused_required_information: { dimension: 'information_utilization', dimensionCap: 50, totalCap: 60, minimumStepCount: 2 },
};

const ISSUE_TRIGGER_GUIDANCE: Record<AgentTrajectoryIssueCode, {
  trigger: string;
  doNotTriggerWhen: string;
}> = {
  duplicate_no_gain: {
    trigger: '同参调用重复出现，返回结果没有新增信息，且 stepIndexes 精确命中 repeatedSameResultCandidates 候选。',
    doNotTriggerWhen: '结果有信息增量，或调用属于必要分页、分片、轮询或幂等恢复时不得触发。',
  },
  irrelevant_detour: {
    trigger: '主任务路径中插入与目标、必要前置或验证无关的探索或上下文切换。',
    doNotTriggerWhen: '至少 3 个非必要步骤形成长路径时不得使用本 code，应使用 excessive_detour；步骤服务于明确依赖、必要验证、合理消歧或错误恢复时不得触发。',
  },
  unchanged_retry_loop: {
    trigger: '失败后参数和策略均未改变而原地重试，且 stepIndexes 精确命中 unchangedRetryCandidates 候选。',
    doNotTriggerWhen: '重试调整了参数、策略、退避条件，或属于有依据的短暂故障恢复时不得触发。',
  },
  avoidable_llm_overuse: {
    trigger: '额外 LLM 步骤仅重复或转述已有确定信息，未为任务增加必要解释、推导或决策。',
    doNotTriggerWhen: '工具结果已直接包含任务所需完整答案且后续仅近似复述时不得使用本 code，应使用 unused_tool_result_processing；动作完成后的必要状态确认，或已有信息仍需必要解释、汇总、转换或基于任务语义作出决策时不得触发。',
  },
  fragmented_mergeable_steps: {
    trigger: '同类独立步骤在当前任务和调用能力下可以安全合并，且 stepIndexes 精确命中 consecutiveSimilarCandidates 候选。',
    doNotTriggerWhen: '步骤存在数据依赖、分页分片、限流约束或必须串行执行时不得触发；同一组步骤已构成长路径偏航时也不得触发，应优先 excessive_detour。',
  },
  excessive_detour: {
    trigger: '至少 3 个连续或累计的非必要探索步骤显著延后核心动作，形成明显长路径偏航。',
    doNotTriggerWhen: '少于 3 个非必要步骤时使用 irrelevant_detour；探索用于完成必要前置、验证关键假设、合理消歧或恢复失败时不得触发。',
  },
  unused_tool_result_processing: {
    trigger: '仅当成功工具 output 已经是用户请求的完整内容，且终态回答的语义只是近似复述该 output（包括逐项复述完整列表或只添加自然语言包装），不是动作执行后的状态确认、错误恢复说明，也没有增加新信息时触发；stepIndexes 必须锚定该成功工具结果和终态回答；同时符合时优先使用本 code，不得改用 avoidable_llm_overuse。',
    doNotTriggerWhen: '工具结果被正常读取并用于一次必要回答时不得触发；动作完成后的确认、错误恢复或降级结果说明、确有必要的非平凡解释、语义推导或格式转换、补充工具结果未包含的有效信息，均属于一次必要回答，不得触发。',
  },
  overrollback: {
    trigger: '局部失败没有使前序成果失效，却无依据重做已经完成的前序链路。',
    doNotTriggerWhen: '失败确实使依赖状态失效，或一致性与安全要求必须重新执行前序步骤时不得触发。',
  },
  goal_drift: {
    trigger: '执行目标无依据扩大、替换或持续偏离用户原始目标；多个与原目标无关的连续动作扩大任务范围时，即使最终返回原目标也属于持续漂移。',
    doNotTriggerWhen: '子任务、单个辅助检查或所选手段仍直接服务原始目标时不得触发，即使该手段缺少依据、遗漏验证或最终结果不正确；明确前置或用户追加要求也不得触发。最终完成原目标不能抵消此前多个无关动作造成的持续漂移。',
  },
  missing_required_step: {
    trigger: '遗漏用户明确要求、显式前置关系、给定关键动作或使结论成立所必需的验证。',
    doNotTriggerWhen: '仅凭行业习惯或未提供的隐藏标准推测额外流程时不得触发。',
  },
  unsupported_reasoning_jump: {
    trigger: '可观察轨迹中的关键决策缺少前序事实、工具结果或必要检查支撑。',
    doNotTriggerWhen: '决策已由可观察事实直接支持，或任务无需额外检查即可成立时不得触发。',
  },
  unhandled_recoverable_error: {
    trigger: '出现可恢复错误后直接失败，且未作合理重试、参数调整或降级。',
    doNotTriggerWhen: '错误不可恢复、继续操作不安全，或轨迹已采取合理恢复或降级时不得触发。',
  },
  contradicted_tool_result: {
    trigger: '逐项比较工具返回的关键事实与后续结论；存在数值、布尔值或其他关键事实直接冲突时必须触发，即后续结论与已返回且仍有效的关键工具事实直接矛盾。数值 0 与宣称对应对象存在、可用或充足的结论直接冲突，false 与同一事实的肯定结论直接冲突。',
    doNotTriggerWhen: '后续有更新证据取代旧结果，或结论与工具事实并不冲突时不得触发。',
  },
  decision_thrashing: {
    trigger: '没有新证据、失败反馈或约束变化，却在已经选择的方案之间至少两次反复切换。',
    doNotTriggerWhen: '方案切换由新证据、失败反馈或约束变化明确驱动时不得触发；仅连续使用不同工具、执行多个无关步骤或发生目标偏移，但没有在已选方案之间至少两次来回切换时也不得触发。',
  },
  internal_contradiction: {
    trigger: '不同可观察步骤对同一关键事实给出直接冲突且未解释的结论。',
    doNotTriggerWhen: '后续结论基于新证据明确修正旧结论，或讨论的是不同条件时不得触发。',
  },
  unused_required_information: {
    trigger: '逐项比较任务要求的必要字段、可观察工具结果和最终答案；可观察工具结果明确返回任务要求的必要字段但最终遗漏时必须触发。',
    doNotTriggerWhen: '仅有任务文本或普通上下文、没有可观察工具返回该必要字段时不得触发；字段对当前任务可选、无关、已被替代或未被用户要求时也不得触发。',
  },
};

const DIMENSION_GUIDANCE: Record<string, { definition: string; exclusions: string[] }> = {
  step_necessity: {
    definition: '评价每一步是否对任务目标、必要验证或合理恢复有贡献。',
    exclusions: [
      '重试问题属于 retry_efficiency，不得仅因一般失败或重试后果将本维标为非 met。',
      'LLM 重复属于 cost_efficiency，不得仅因重复处理将本维标为非 met。',
      'excessive_detour 对 step_necessity 的附加影响由代码处理，Judge 不得为此另造本维问题。',
    ],
  },
  path_detour: {
    definition: '评价是否存在可避免的偏航、上下文切换或长路径。',
    exclusions: [
      '必要前置、验证、消歧或错误恢复不得视为绕路。',
      '同一根因同时符合时 excessive_detour 优先于 irrelevant_detour。',
    ],
  },
  cost_efficiency: {
    definition: '评价是否存在可证实的无信息增量 LLM 或处理浪费。',
    exclusions: [
      '重试与 overrollback 属于 retry_efficiency，不得仅因其一般成本后果将本维标为非 met。',
      '同一锚点符合 duplicate_no_gain 时该 code 优先，不得仅因一般成本后果重复报本维问题。',
    ],
  },
  step_density: {
    definition: '评价步骤粒度是否合理，以及同类操作是否可以安全合并。',
    exclusions: [
      '存在数据依赖、分页、分片、限流约束或必须串行时不得判为可合并。',
      '长路径偏航已由同一组步骤构成时，不得再以一般粒度后果返回 fragmented_mergeable_steps。',
    ],
  },
  retry_efficiency: {
    definition: '评价失败后是否调整参数或策略，以及回退范围是否必要。',
    exclusions: [
      '重试问题不得因一般负面后果扩散到 cost_efficiency 或 step_necessity。',
    ],
  },
  goal_alignment: {
    definition: '评价关键动作和最终结果是否持续服务用户原始目标。',
    exclusions: [
      '结果不完整或结果不正确本身不等于 goal_drift，不得仅凭结果缺陷触发目标漂移。',
    ],
  },
  planning_completeness: {
    definition: '评价实际执行路径是否覆盖必要前置、子任务和验证。',
    exclusions: [
      '没有显式计划文本本身不得判为缺失步骤。',
    ],
  },
  reasoning_coherence: {
    definition: '评价可观察决策是否有前序证据支撑并保持前后一致。',
    exclusions: [
      '与工具事实冲突属于 information_utilization，不得仅因该后果扩散到本维。',
    ],
  },
  exception_handling: {
    definition: '评价可恢复错误后是否采取合理重试、参数调整或降级。',
    exclusions: [
      '轨迹没有错误时本维必须为 met。',
    ],
  },
  path_robustness: {
    definition: '评价方案切换是否由新证据驱动，以及执行路径是否稳定。',
    exclusions: [
      '少于两次无新证据的方案切换不得触发 decision_thrashing。',
    ],
  },
  information_utilization: {
    definition: '先逐项比较任务要求的字段、工具返回关键事实和最终答案，再评价已有上下文、工具返回和中间状态是否被正确且充分使用。',
    exclusions: [
      'contradicted_tool_result 必须存在数值、布尔值或其他关键事实的直接冲突。',
      'unused_required_information 只允许在可观察工具结果明确返回任务要求的必要字段但最终遗漏时使用。',
      '仅有任务文本或普通上下文、没有可观察工具返回必要字段时不得触发 unused_required_information。',
    ],
  },
};

export interface AgentTrajectoryPromptIssueRule {
  code: AgentTrajectoryIssueCode;
  dimension: string;
  trigger: string;
  doNotTriggerWhen: string;
  minimumStepCount?: number;
}

export interface AgentTrajectoryPromptDimensionRule {
  dimension: string;
  definition: string;
  allowedIssueCodes: AgentTrajectoryIssueCode[];
  exclusions: string[];
}

export interface AgentTrajectoryPromptMechanicalRules {
  stepIndexes: string[];
  candidateRequirements: Record<string, string>;
  toolName: string[];
  verdictIssueConsistency: string[];
  stringFields: string[];
  evaluationOrder: string[];
}

export function agentTrajectoryPromptIssueRules(
  kind: AgentTrajectoryEvaluatorKind,
): AgentTrajectoryPromptIssueRule[] {
  const dimensions = dimensionsFor(kind);
  return ISSUE_CODES
    .filter(code => dimensions.includes(ISSUE_RULES[code].dimension))
    .map(code => ({
      code,
      dimension: ISSUE_RULES[code].dimension,
      ...ISSUE_TRIGGER_GUIDANCE[code],
      ...(ISSUE_RULES[code].minimumStepCount
        ? { minimumStepCount: ISSUE_RULES[code].minimumStepCount }
        : {}),
    }));
}

export function agentTrajectoryPromptDimensionRules(
  kind: AgentTrajectoryEvaluatorKind,
): AgentTrajectoryPromptDimensionRule[] {
  return dimensionsFor(kind).map(dimension => ({
    dimension,
    definition: DIMENSION_GUIDANCE[dimension].definition,
    allowedIssueCodes: ISSUE_CODES.filter(code => ISSUE_RULES[code].dimension === dimension),
    exclusions: [...DIMENSION_GUIDANCE[dimension].exclusions],
  }));
}

export function agentTrajectoryPromptMechanicalRules(
  kind: AgentTrajectoryEvaluatorKind,
): AgentTrajectoryPromptMechanicalRules {
  void kind;
  return {
    stepIndexes: [
      'stepIndexes 必须是非空整数数组并且必须去重，每个值都必须存在于 trajectoryFacts.steps[].index。',
      'stepIndexes 只能锚定实际支持该问题所需的最小索引集合，不得引用数组位置、interactionIndex、无关步骤或虚构索引。',
    ],
    candidateRequirements: {
      duplicate_no_gain: 'stepIndexes 至少包含 3 个索引，排序后必须与 trajectoryFacts.candidates.repeatedSameResultCandidates 中某一项完全一致，且该候选也必须至少包含 3 个 stepIndexes。',
      unchanged_retry_loop: 'stepIndexes 排序后必须与 trajectoryFacts.candidates.unchangedRetryCandidates 中某一项完全一致。',
      fragmented_mergeable_steps: 'stepIndexes 至少包含 3 个索引，排序后必须与 trajectoryFacts.candidates.consecutiveSimilarCandidates 中某一项完全一致，且该候选也必须至少包含 3 个 stepIndexes。',
      unused_tool_result_processing: 'stepIndexes 至少包含 3 个索引，必须同时包含一个非失败工具步骤、工具之后的额外处理中间步骤和时间上更晚的真正根级终态回答；普通必要回答不得触发。只有工具 output 已经是用户请求的完整内容且后续处理中间步骤与终态回答仅近似复述时才允许触发；逐项复述完整列表或只添加自然语言包装仍属于近似复述，动作完成确认、错误恢复说明以及必要的非平凡解释、语义推导或格式转换不得触发。',
    },
    toolName: [
      'toolName 填写后必须与所有 stepIndexes 锚定的具名工具步骤 name 完全一致。',
      'toolName 是可选证据字段；省略时不得因缺少工具名而补填或拒绝问题。',
      '没有具名工具步骤或锚定了多个不同 name 时必须省略 toolName，不得填写空字符串或 null。',
    ],
    verdictIssueConsistency: [
      'partial 或 missing 仅在至少一个同一维度的问题通过 grounding 后才允许；问题 dimension 必须与固定映射完全一致。',
      'met 维度不得关联任何负面问题。',
    ],
    stringFields: [
      'summary、dimension.reason、issue.reason 和 issue.suggestion 必须为非空字符串，不得为空白或 null。',
      'met 的 dimension.suggestion 必须是空字符串；partial 或 missing 的 dimension.suggestion 必须是非空字符串。',
    ],
    evaluationOrder: [
      '先根据可观察事实产生通过 grounding 的 grounded issues，再从这些 issues 派生 dimensions verdict；不得先写 verdict 后凑问题。',
      '某维没有同维且合法的 grounded issue 时，该维必须为 met。',
      '一般负面后果不得跨维扩散；Judge 只按固定 dimension 标记问题，额外维度影响由代码处理。',
      '同一根因符合 duplicate_no_gain 时优先使用该 code，不得因一般后果重复报其他维度问题。',
      '同一根因同时符合 excessive_detour 与 irrelevant_detour 时，优先 excessive_detour 并省略 irrelevant_detour。',
      '同一组步骤同时符合 excessive_detour 与 fragmented_mergeable_steps 时，优先 excessive_detour 并省略 fragmented_mergeable_steps。',
    ],
  };
}

export function trajectoryIssueAffectsDimension(
  issue: GroundedTrajectoryIssue,
  dimension: string,
): boolean {
  const rule = ISSUE_RULES[issue.code];
  return rule.dimension === dimension || rule.additionalDimensionCap?.dimension === dimension;
}

function containsChinese(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

const chineseTextSchema = z.string().trim().min(1).refine(containsChinese, '必须包含中文解释');
const chineseSuggestionSchema = z.string().superRefine((value, context) => {
  if (value.trim() && !containsChinese(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: '建议必须包含中文' });
  }
});

const verdictSchema = z.enum(['met', 'partial', 'missing']);
const dimensionSchema = z.object({
  dimension: z.string().trim().min(1),
  verdict: verdictSchema,
  reason: chineseTextSchema,
  suggestion: chineseSuggestionSchema,
}).strict().superRefine((value, context) => {
  const hasSuggestion = Boolean(value.suggestion.trim());
  if (value.verdict === 'met' && hasSuggestion) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['suggestion'], message: 'met 维度不得提供建议' });
  }
  if (value.verdict !== 'met' && !hasSuggestion) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['suggestion'], message: 'partial/missing 必须提供改进建议' });
  }
});

const issueSchema = z.object({
  code: z.enum(ISSUE_CODES),
  severity: z.enum(['minor', 'major', 'critical']),
  dimension: z.string().trim().min(1),
  stepIndexes: z.array(z.number().int().nonnegative()).min(1),
  toolName: z.string().trim().min(1).optional(),
  reason: chineseTextSchema,
  suggestion: chineseTextSchema,
}).strict().superRefine((value, context) => {
  if (new Set(value.stepIndexes).size !== value.stepIndexes.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['stepIndexes'], message: 'stepIndexes 必须去重' });
  }
});

const judgmentSchema = z.object({
  summary: z.string().trim().min(1).max(200).refine(containsChinese, 'summary 必须包含中文解释'),
  dimensions: z.array(dimensionSchema),
  issues: z.array(issueSchema).default([]),
}).strict();

type ParsedJudgment = z.infer<typeof judgmentSchema>;

function judgeError(message: string, raw: unknown): JudgeOutputParseError {
  let rawText = '';
  try {
    rawText = JSON.stringify(raw);
  } catch {
    rawText = String(raw);
  }
  return new JudgeOutputParseError(message, rawText);
}

function parseJudgment(kind: AgentTrajectoryEvaluatorKind, raw: unknown): ParsedJudgment {
  void kind;
  const parsed = judgmentSchema.safeParse(raw);
  if (!parsed.success) {
    throw judgeError(`Judge 输出契约无效：${parsed.error.issues.map(item => item.message).join('；')}`, raw);
  }
  return parsed.data;
}

function dimensionsFor(kind: AgentTrajectoryEvaluatorKind): readonly string[] {
  return kind === 'step-efficiency' ? EFFICIENCY_DIMENSIONS : QUALITY_DIMENSIONS;
}

function validateDimensions(kind: AgentTrajectoryEvaluatorKind, judgment: ParsedJudgment, raw: unknown): void {
  const expected = dimensionsFor(kind);
  const actual = judgment.dimensions.map(item => item.dimension);
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || actual.some(item => !expected.includes(item))) {
    throw judgeError('Judge dimensions 必须完整、唯一且仅包含当前 rubric 的固定维度。', raw);
  }
}

function sortedIndexes(indexes: number[]): number[] {
  return [...indexes].sort((left, right) => left - right);
}

function issueKey(issue: GroundedTrajectoryIssue): string {
  return [issue.code, issue.dimension, sortedIndexes(issue.stepIndexes).join(','), issue.toolName ?? ''].join('|');
}

function exactIndexes(left: number[], right: number[]): boolean {
  const normalizedLeft = sortedIndexes(left);
  const normalizedRight = sortedIndexes(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}

function matchesCandidate(
  facts: AgentTrajectoryFacts,
  name: keyof AgentTrajectoryFacts['candidates'],
  stepIndexes: number[],
  minimumStepCount = 1,
): boolean {
  return facts.candidates[name].some(candidate => (
    candidate.stepIndexes.length >= minimumStepCount
    && exactIndexes(candidate.stepIndexes, stepIndexes)
  ));
}

function anchoredSteps(
  facts: AgentTrajectoryFacts,
  stepIndexes: number[],
): AgentTrajectoryFacts['steps'] {
  return stepIndexes
    .map(index => facts.steps.find(step => step.index === index))
    .filter((step): step is AgentTrajectoryFacts['steps'][number] => Boolean(step));
}

function findTerminalAnswer(
    facts: AgentTrajectoryFacts,
): AgentTrajectoryFacts['steps'][number] | undefined {
    const agentSteps = facts.steps
    .filter(step => step.kind !== 'user' && step.depth === 0 && step.visibleText !== false)
    .sort(compareAgentTrajectoryStepTemporalOrder);
    const lastAgentStep = agentSteps.at(-1);
    if (!lastAgentStep
    || lastAgentStep.kind !== 'llm'
    || ['error', 'timeout', 'cancelled'].includes(lastAgentStep.status)
    || !lastAgentStep.textSummary?.trim()) {
        return undefined;
    }
    const latestRootUser = latestRootUserStep(facts);
    if (latestRootUser && compareAgentTrajectoryStepTemporalOrder(lastAgentStep, latestRootUser) <= 0) {
        return undefined;
    }
    const hasCallableSibling = facts.steps.some(step => (
        step.interactionIndex === lastAgentStep.interactionIndex
        && ['tool', 'skill', 'task'].includes(step.kind)
  ));
  return hasCallableSibling ? undefined : lastAgentStep;
}

function latestRootUserStep(
  facts: AgentTrajectoryFacts,
): AgentTrajectoryFacts['steps'][number] | undefined {
  return facts.steps
    .filter(step => step.kind === 'user' && step.depth === 0)
    .sort(compareAgentTrajectoryStepTemporalOrder)
    .at(-1);
}

function isAfterLatestRootUser(
  facts: AgentTrajectoryFacts,
  step: AgentTrajectoryFacts['steps'][number],
): boolean {
  const latestUser = latestRootUserStep(facts);
  return !latestUser || compareAgentTrajectoryStepTemporalOrder(step, latestUser) > 0;
}

function sameProcessingAgent(
  left: AgentTrajectoryFacts['steps'][number],
  right: AgentTrajectoryFacts['steps'][number],
): boolean {
  return (left.agentNodeId ?? `${left.depth}:${left.agent || ''}`)
    === (right.agentNodeId ?? `${right.depth}:${right.agent || ''}`);
}

function hasSuccessfulToolWithTerminalAnswer(
  facts: AgentTrajectoryFacts,
  stepIndexes: number[],
): boolean {
  const evidenceSteps = anchoredSteps(facts, stepIndexes);
    const finalAnswerStep = findTerminalAnswer(facts);
    if (!finalAnswerStep || !stepIndexes.includes(finalAnswerStep.index)) return false;
    const toolStep = evidenceSteps.find(step => (
        step.kind === 'tool'
        && step.status === 'ok'
        && step.outputSummary !== undefined
        && compareAgentTrajectoryStepTemporalOrder(step, finalAnswerStep) < 0
    ));
    if (!toolStep) return false;
    if (!isAfterLatestRootUser(facts, toolStep)) return false;
    if (evidenceSteps.some(step => step.kind === 'llm'
        && step.index !== finalAnswerStep.index
        && step.visibleText !== false
        && sameProcessingAgent(toolStep, step)
        && compareAgentTrajectoryStepTemporalOrder(toolStep, step) < 0
        && compareAgentTrajectoryStepTemporalOrder(step, finalAnswerStep) < 0)) {
        return true;
    }
    return false;
}

function hasIssueStructure(
  code: AgentTrajectoryIssueCode,
  facts: AgentTrajectoryFacts,
  stepIndexes: number[],
): boolean {
  const evidenceSteps = anchoredSteps(facts, stepIndexes)
    .sort(compareAgentTrajectoryStepTemporalOrder);
  const terminalAnswer = findTerminalAnswer(facts);
  const hasAnchoredTerminal = Boolean(terminalAnswer && stepIndexes.includes(terminalAnswer.index));
  const failedCallables = evidenceSteps.filter(step => (
    ['tool', 'skill', 'task'].includes(step.kind)
    && ['error', 'timeout', 'cancelled'].includes(step.status)
  ));
  if (['overrollback', 'decision_thrashing', 'internal_contradiction'].includes(code)
    && evidenceSteps.some(step => !isAfterLatestRootUser(facts, step))) {
    return false;
  }

  if (code === 'unused_tool_result_processing') {
    return hasSuccessfulToolWithTerminalAnswer(facts, stepIndexes);
  }
  if (code === 'contradicted_tool_result' || code === 'unused_required_information') {
    const finalAnswer = findTerminalAnswer(facts);
    return Boolean(finalAnswer && stepIndexes.includes(finalAnswer.index) && evidenceSteps.some(step => (
      step.kind === 'tool'
      && !['error', 'timeout', 'cancelled'].includes(step.status)
      && step.outputSummary !== undefined
      && isAfterLatestRootUser(facts, step)
      && compareAgentTrajectoryStepTemporalOrder(step, finalAnswer) < 0
    )));
  }
  if (code === 'unhandled_recoverable_error') {
    if (terminalAnswer) {
      return hasAnchoredTerminal && failedCallables.some(failedCallable => (
        isAfterLatestRootUser(facts, failedCallable)
        &&
        compareAgentTrajectoryStepTemporalOrder(failedCallable, terminalAnswer) < 0
      ));
    }
    const lastAgentStep = facts.steps
      .filter(step => step.kind !== 'user')
      .sort(compareAgentTrajectoryStepTemporalOrder)
      .at(-1);
    return Boolean(lastAgentStep && isAfterLatestRootUser(facts, lastAgentStep) && failedCallables.some(failedCallable => (
      failedCallable.index === lastAgentStep.index
    )));
  }
  if (code === 'overrollback') {
    return failedCallables.some(failedCallable => (
      evidenceSteps.some(step => ['tool', 'skill', 'task'].includes(step.kind)
        && compareAgentTrajectoryStepTemporalOrder(step, failedCallable) < 0)
      && evidenceSteps.some(step => ['tool', 'skill', 'task'].includes(step.kind)
        && compareAgentTrajectoryStepTemporalOrder(step, failedCallable) > 0)
    ));
  }
  if (code === 'decision_thrashing') {
    return evidenceSteps.filter(step => step.kind !== 'user').length >= 3;
  }
  if (code === 'internal_contradiction') {
    return evidenceSteps.filter(step => step.kind === 'llm').length >= 2;
  }
  if (code === 'avoidable_llm_overuse' || code === 'unsupported_reasoning_jump') {
    return evidenceSteps.some(step => step.kind === 'llm');
  }
  if (code === 'irrelevant_detour'
    || code === 'excessive_detour'
    || code === 'goal_drift'
    || code === 'missing_required_step') {
    return evidenceSteps.some(step => step.kind !== 'user');
  }
  return true;
}

function groundIssues(
  kind: AgentTrajectoryEvaluatorKind,
  facts: AgentTrajectoryFacts,
  rawIssues: z.infer<typeof issueSchema>[],
): {
  issues: GroundedTrajectoryIssue[];
  discardedIssues: DiscardedTrajectoryIssue[];
} {
  const stepByIndex = new Map(facts.steps.map(step => [step.index, step]));
  const issues: GroundedTrajectoryIssue[] = [];
  const discardedIssues: DiscardedTrajectoryIssue[] = [];

  for (const rawIssue of rawIssues) {
    const rule = ISSUE_RULES[rawIssue.code];
    if (!dimensionsFor(kind).includes(rule.dimension)) {
      throw judgeError(`问题 ${rawIssue.code} 不属于当前 ${kind} rubric。`, rawIssue);
    }
    const issue: GroundedTrajectoryIssue = {
      ...rawIssue,
      code: rawIssue.code,
      dimension: rule.dimension,
      stepIndexes: sortedIndexes(rawIssue.stepIndexes),
    };
    if (rawIssue.dimension !== rule.dimension) {
      throw judgeError(`问题 ${rawIssue.code} 与维度 ${rawIssue.dimension} 不匹配。`, rawIssue);
    }
    if (issue.stepIndexes.some(index => !stepByIndex.has(index))) {
      discardedIssues.push({ ...issue, discardReason: '问题引用了不存在的轨迹步骤。' });
      continue;
    }
    if (rule.minimumStepCount && issue.stepIndexes.length < rule.minimumStepCount) {
      discardedIssues.push({
        ...issue,
        discardReason: `问题至少需要 ${rule.minimumStepCount} 个锚定步骤。`,
      });
      continue;
    }
    if (!hasIssueStructure(issue.code, facts, issue.stepIndexes)) {
      discardedIssues.push({
        ...issue,
        discardReason: '问题锚点未形成该问题所需的可观察步骤关系。',
      });
      continue;
    }
    const namedToolSteps = issue.stepIndexes
      .map(index => stepByIndex.get(index))
      .filter((step): step is NonNullable<typeof step> => step?.kind === 'tool' && Boolean(step.name));
    const namedTools = new Set(namedToolSteps.map(step => step.name as string));
    const requiredToolName = namedTools.size === 1 ? [...namedTools][0] : undefined;
    if ((issue.toolName !== undefined && (!requiredToolName || issue.toolName !== requiredToolName))) {
      discardedIssues.push({
        ...issue,
        discardReason: requiredToolName
          ? `toolName 必须与锚定工具名 ${requiredToolName} 一致。`
          : '锚定步骤没有唯一工具名时不得填写 toolName。',
      });
      continue;
    }
    if (rule.deterministicCandidate && !matchesCandidate(
      facts,
      rule.deterministicCandidate,
      issue.stepIndexes,
      rule.minimumStepCount,
    )) {
      discardedIssues.push({ ...issue, discardReason: '确定性问题未命中事实层候选。' });
      continue;
    }
    issues.push(issue);
  }
  return { issues, discardedIssues };
}

function deduplicateIssues(issues: GroundedTrajectoryIssue[]): GroundedTrajectoryIssue[] {
  const unique = new Map<string, GroundedTrajectoryIssue>();
  for (const issue of issues) {
    if (!unique.has(issueKey(issue))) unique.set(issueKey(issue), issue);
  }
  const values = [...unique.values()];
  return values.filter(issue => {
    if (issue.code === 'irrelevant_detour' && values.some(other => (
      other.code === 'excessive_detour'
      && (!other.toolName || !issue.toolName || other.toolName === issue.toolName)
      && exactIndexes(other.stepIndexes, issue.stepIndexes)
    ))) return false;
    if (issue.code === 'fragmented_mergeable_steps' && values.some(other => (
      other.code === 'duplicate_no_gain'
      && other.toolName === issue.toolName
      && exactIndexes(other.stepIndexes, issue.stepIndexes)
    ))) return false;
    if (issue.code === 'fragmented_mergeable_steps' && values.some(other => (
      other.code === 'excessive_detour'
      && (!other.toolName || !issue.toolName || other.toolName === issue.toolName)
      && (
        issue.stepIndexes.every(index => other.stepIndexes.includes(index))
        || other.stepIndexes.every(index => issue.stepIndexes.includes(index))
      )
    ))) return false;
    return true;
  });
}

function validateIssueEvidence(judgment: ParsedJudgment, issues: GroundedTrajectoryIssue[], raw: unknown): void {
  for (const dimension of judgment.dimensions) {
    const related = issues.filter(issue => issue.dimension === dimension.dimension);
    if (dimension.verdict === 'met' && related.length > 0) {
      throw judgeError(`met 维度 ${dimension.dimension} 不得关联负面问题。`, raw);
    }
    if (dimension.verdict !== 'met' && related.length === 0) {
      throw judgeError(`非 met 维度 ${dimension.dimension} 缺少通过事实锚定的问题。`, raw);
    }
  }
}

function scoreForVerdict(verdict: AgentTrajectoryVerdict): number {
  if (verdict === 'met') return 100;
  if (verdict === 'partial') return 50;
  return 0;
}

function scoreAssessment(
  kind: AgentTrajectoryEvaluatorKind,
  judgment: ParsedJudgment,
  issues: GroundedTrajectoryIssue[],
): Pick<AgentTrajectoryAssessment, 'dimensions' | 'baseScore' | 'score' | 'appliedCaps'> {
  const capsByDimension = new Map<string, number>();
  const appliedCaps: AppliedTrajectoryCap[] = [];
  let totalCap = 100;
  for (const issue of issues) {
    const rule = ISSUE_RULES[issue.code];
    const currentDimensionCap = capsByDimension.get(rule.dimension);
    if (currentDimensionCap === undefined || rule.dimensionCap < currentDimensionCap) {
      capsByDimension.set(rule.dimension, rule.dimensionCap);
      appliedCaps.push({ code: issue.code, scope: 'dimension', dimension: rule.dimension, cap: rule.dimensionCap });
    }
    if (rule.additionalDimensionCap) {
      const currentAdditionalCap = capsByDimension.get(rule.additionalDimensionCap.dimension);
      if (currentAdditionalCap === undefined || rule.additionalDimensionCap.cap < currentAdditionalCap) {
        capsByDimension.set(rule.additionalDimensionCap.dimension, rule.additionalDimensionCap.cap);
        appliedCaps.push({
          code: issue.code,
          scope: 'additional-dimension',
          dimension: rule.additionalDimensionCap.dimension,
          cap: rule.additionalDimensionCap.cap,
        });
      }
    }
    if (rule.totalCap < totalCap) {
      totalCap = rule.totalCap;
      appliedCaps.push({ code: issue.code, scope: 'total', dimension: issue.dimension, cap: rule.totalCap });
    }
  }
  const byDimension = new Map(judgment.dimensions.map(item => [item.dimension, item]));
  const dimensions = dimensionsFor(kind).map(dimension => {
    const judgmentDimension = byDimension.get(dimension)!;
    const impactingIssues = issues.filter(issue => trajectoryIssueAffectsDimension(issue, dimension));
    const rawScore = scoreForVerdict(judgmentDimension.verdict);
    const cap = capsByDimension.get(dimension);
    const score = cap === undefined ? rawScore : Math.min(rawScore, cap);
    return {
      dimension,
      verdict: judgmentDimension.verdict,
      reason: judgmentDimension.reason,
      suggestion: judgmentDimension.suggestion || uniqueStrings(impactingIssues.map(issue => issue.suggestion)).join('；'),
      rawScore,
      score,
      status: score === 100 ? 'covered' : score >= 40 ? 'partial' : 'missing',
      anchors: uniqueStrings(impactingIssues.flatMap(
        issue => issue.stepIndexes.map(index => `step-${index}`),
      )),
    } satisfies AgentTrajectoryDimensionResult;
  });
  const baseScore = roundOneDecimal(dimensions.reduce((total, dimension) => total + dimension.score, 0) / dimensions.length);
  return { dimensions, baseScore, score: roundOneDecimal(Math.min(baseScore, totalCap)), appliedCaps };
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function roundOneDecimal(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function factsSummary(facts: AgentTrajectoryFacts): Record<string, unknown> {
  return {
    stepCount: facts.steps.length,
    statistics: facts.statistics,
    candidateCounts: {
      repeatedSameCall: facts.candidates.repeatedSameCallCandidates.length,
      repeatedSameResult: facts.candidates.repeatedSameResultCandidates.length,
      unchangedRetry: facts.candidates.unchangedRetryCandidates.length,
      consecutiveSimilar: facts.candidates.consecutiveSimilarCandidates.length,
    },
  };
}

function singleVisibleRootLlmWithoutCallable(
  facts: AgentTrajectoryFacts,
): AgentTrajectoryFacts['steps'][number] | undefined {
  const visibleLlmSteps = facts.steps
    .filter(step => step.kind === 'llm' && step.depth === 0 && step.visibleText !== false && isAfterLatestRootUser(facts, step))
    .sort(compareAgentTrajectoryStepTemporalOrder);
  const hasCallable = facts.steps.some(step => (
    ['tool', 'skill', 'task'].includes(step.kind) && isAfterLatestRootUser(facts, step)
  ));
  return !hasCallable && visibleLlmSteps.length === 1 ? visibleLlmSteps[0] : undefined;
}

export function buildAgentTrajectoryAssessment(
  kind: AgentTrajectoryEvaluatorKind,
  facts: AgentTrajectoryFacts,
  judgment: unknown,
): AgentTrajectoryAssessment {
  const parsed = parseJudgment(kind, judgment);
  validateDimensions(kind, parsed, judgment);
  const grounded = groundIssues(kind, facts, parsed.issues);
  let effectiveJudgment = parsed;
  let issues = deduplicateIssues(grounded.issues);
  const discardedIssues = [...grounded.discardedIssues];
  if (kind === 'process-quality') {
    const directAnswerStep = singleVisibleRootLlmWithoutCallable(facts);
    if (directAnswerStep) {
      const missingRequiredStep = issues.some(issue => issue.code === 'missing_required_step');
      const unsupportedReasoningJump = issues.find(issue => issue.code === 'unsupported_reasoning_jump');
      if (missingRequiredStep && !unsupportedReasoningJump) {
        const fallbackIssue: GroundedTrajectoryIssue = {
          code: 'unsupported_reasoning_jump',
          severity: 'major',
          dimension: ISSUE_RULES.unsupported_reasoning_jump.dimension,
          stepIndexes: [directAnswerStep.index],
          reason: '关键决策只有结论，没有可观察事实或检查支撑。',
          suggestion: '先记录可观察指标或验证结果，再基于证据做出决策。',
        };
        issues = deduplicateIssues([...issues, fallbackIssue]);
        effectiveJudgment = {
          ...effectiveJudgment,
          dimensions: effectiveJudgment.dimensions.map(dimension => dimension.dimension === 'reasoning_coherence'
            ? { ...dimension, verdict: 'partial' as const, suggestion: '补充支撑关键决策的可观察事实或检查结果。' }
            : dimension),
        };
      }
    }
  }
  validateIssueEvidence(effectiveJudgment, issues, judgment);
  const scored = scoreAssessment(kind, effectiveJudgment, issues);
  return {
    kind,
    rubricVersion: kind === 'step-efficiency' ? 'agent-step-efficiency/1.0.0' : 'agent-process-quality/1.0.0',
    summary: parsed.summary,
    ...scored,
    issues,
    discardedIssues,
    factsSummary: factsSummary(facts),
  };
}
