/**
 * 忠实版预置 LLM 评估器适配层：只负责
 *   preset-agent-task-completion / preset-agent-trace-quality
 * 两个既有预置评估器，复用「评测执行」原有的 opencode 逻辑（四固定维度 / 关键观点 /
 * skill 归因 / deviation 步骤），并把原 0–1 输出映射到统一 0–100 契约。
 *
 * 本文件还定义实验预置评估器共用的 FaithfulPresetContext。新增的回答深度性、Tool/Skill
 * 利用率和选择合理性评估器只复用该运行上下文，不由 runFaithfulPreset 执行；它们的实现位于
 * src/lib/engine/experiment/depth-preset-evaluators.ts、agent-tool-utilization-evaluator.ts 和
 * agent-tool-selection-evaluator.ts。
 * evaluatorContext 保存显式可用 Tool/Skill 目录，evaluatorContextError 传递历史存量 JSON
 * 无法解析的原因；这两个字段只影响工具类评估器，不改变上述既有评估器的评分口径。
 */
// 原 opencode 评估器传递依赖 @opencode-ai/sdk（server-only，node --test 无法静态加载）。
// 与 judge-llm.ts 同策略：惰性 import()，运行时才加载——测试注入/纯函数校验时零加载。
import { normalizeEvaluatorOutput, type EvaluatorOutput, type EvalPoint, type EvalPointStatus } from '../../evaluators/eval-output';
import type { EvaluatorCaseContext } from '../../evaluators/evaluator-case-context';

export const FAITHFUL_PRESET_IDS = ['preset-agent-task-completion', 'preset-agent-trace-quality'] as const;
export type FaithfulPresetId = (typeof FAITHFUL_PRESET_IDS)[number];

export function isFaithfulPresetId(id: string): id is FaithfulPresetId {
  return (FAITHFUL_PRESET_IDS as readonly string[]).includes(id);
}

export interface FaithfulPresetContext {
  caseInput: string;
  actualOutput: string;
  referenceOutput: string | null;
  /** 压缩执行轨迹文本（任务完成度用作 traceSummaryText） */
  traceSummaryText: string | null;
  /** 原始 interactions（轨迹评估器用作 actualInteractions） */
  interactions: unknown[];
  /** 工具类评估器使用的显式可用工具目录；null/undefined 表示未提供。 */
  evaluatorContext?: EvaluatorCaseContext | null;
  /** 历史脏数据解析错误；工具类评估器据此输出不计分原因。 */
  evaluatorContextError?: string | null;
  taskId: string | null;
  executionId: string | null;
  /** trace 归属用户（skill 记录按 user 查找） */
  user?: string | null;
  /** case 对应的 Execution 记录（含 skill/skillVersion/invokedSkills）——
   *  用于检测 skill 上下文做 skill 归因；与单组/对比无关，取决于 trace 用没用 skill。 */
  execution?: {
    id?: string | null; taskId?: string | null; query?: string | null; finalResult?: string | null;
    skill?: string | null; skillVersion?: number | null; invokedSkills?: string | null; skills?: string | null;
  } | null;
}

/** 测试注入点：跳过真实 opencode 调用，直接返回给定输出（同 judge-llm 的 setJudgeLlmCallerForTest）。 */
type FaithfulRunner = (id: FaithfulPresetId, user: string, ctx: FaithfulPresetContext) => Promise<EvaluatorOutput>;
let testRunner: FaithfulRunner | null = null;
export function setFaithfulPresetRunnerForTest(fn: FaithfulRunner | null): void {
  testRunner = fn;
}

/** 分发：按 id 调对应原评估器并映射到统一契约。 */
export async function runFaithfulPreset(
  id: FaithfulPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  if (testRunner) return testRunner(id, user, ctx);
  if (id === 'preset-agent-task-completion') return runTaskCompletion(user, ctx);
  return runTrajectoryQuality(user, ctx);
}

// ── 通用小工具 ───────────────────────────────────────────────────────────────

const to100 = (v: number | null | undefined): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 1000) / 10)) : undefined;

/** coverage_status（含 wrong）→ 契约 status；covered/partial/missing/wrong，其它→不设 */
function coverageToStatus(cov: unknown): EvalPointStatus | undefined {
  if (typeof cov !== 'string') return undefined;
  const s = cov.trim().toLowerCase();
  if (s === 'covered') return 'covered';
  if (s === 'partial') return 'partial';
  if (s === 'missing' || s === 'wrong') return 'missing';
  return undefined;
}

/** related_steps[].step_index → step-N 锚点 */
function stepsToAnchors(steps: unknown): string[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  const out: string[] = [];
  for (const s of steps) {
    const idx = s && typeof s === 'object' ? (s as Record<string, unknown>).step_index : undefined;
    if (typeof idx === 'number') out.push(`step-${idx}`);
  }
  return out.length ? out : undefined;
}

// ── 任务完成度（结果评测）─────────────────────────────────────────────────────

async function runTaskCompletion(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  const { evaluateTaskCompletionViaOpencode } = await import('../evaluation/opencode-task-completion-evaluator');
  // skill 归因取决于 trace 用没用 skill（与单组/对比无关）：检测 execution 的 skill 目标，
  // 有则组 SKILL.md 上下文走 skill-aware 分支，无则 no-skill——与评测执行 run route 一致。
  const { loadTaskCompletionSkillContext, getPrimaryExecutionSkillTargets } = await import('../evaluation/key-action-trace-analysis');
  const skillTargets = getPrimaryExecutionSkillTargets(ctx.execution ?? null, ctx.interactions);
  const skillContext = skillTargets.length
    ? await loadTaskCompletionSkillContext(ctx.execution ?? null, ctx.interactions, ctx.user ?? user)
    : undefined;
  const out = await evaluateTaskCompletionViaOpencode(
    {
      caseInput: ctx.caseInput,
      expectedOutput: ctx.referenceOutput ?? '',
      actualOutput: ctx.actualOutput,
      traceSummaryText: ctx.traceSummaryText ?? undefined,
      skillAttributionMode: skillTargets.length ? 'skill-aware' : 'no-skill',
      skillContext,
    },
    user,
  );

  const findings = Array.isArray((out.rawAnalysis as Record<string, unknown> | undefined)?.key_point_findings)
    ? ((out.rawAnalysis as Record<string, unknown>).key_point_findings as unknown[])
    : [];

  const points: EvalPoint[] = [];
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    const r = f as Record<string, unknown>;
    const label = typeof r.content === 'string' ? r.content : '';
    if (!label.trim()) continue;
    const rootCause = (r.trace_root_cause ?? {}) as Record<string, unknown>;
    const md = [r.explanation, r.coverage_reason, r.missing_reason, rootCause.failure_reason]
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .join('\n');
    points.push({
      label: label.slice(0, 120),
      ...(to100(r.score as number) !== undefined ? { score: to100(r.score as number) } : {}),
      ...(coverageToStatus(r.coverage_status) ? { status: coverageToStatus(r.coverage_status) } : {}),
      ...(typeof r.is_skill_attributable === 'boolean' ? { skillAttributable: r.is_skill_attributable } : {}),
      ...(typeof r.improvement_suggestion === 'string' && r.improvement_suggestion.trim()
        ? { suggestion: r.improvement_suggestion.trim() } : {}),
      ...(stepsToAnchors(rootCause.related_steps) ? { anchors: stepsToAnchors(rootCause.related_steps) } : {}),
      ...(md ? { evidence: { md } } : {}),
    });
  }

  // 结论：原评估器的 reason 本就是"先说任务是否完成、再说核心差异"的一句话总结，
  // 直接作 summary（此前只塞进 evidence，而详情页有评分点时不渲染卡级证据 → 写了看不到）。
  // verdict 用 isCorrect 而非分数阈值——它是评估器自己的达成判定，比 deriveVerdict 更准。
  const score100 = to100(out.score);
  return normalizeEvaluatorOutput({
    verdict: out.isCorrect ? 'pass' : (typeof score100 === 'number' && score100 >= 60 ? 'warn' : 'fail'),
    summary: out.reason,
    score: score100,
    points: points.length ? points : undefined,
    evidence: out.reason ? { md: out.reason } : undefined,
  });
}

// ── 轨迹质量（轨迹评测）───────────────────────────────────────────────────────

const DIM_LABELS: Array<{ key: 'completeness' | 'toolChoice' | 'redundancy'; label: string; factor: string }> = [
  { key: 'completeness', label: '完整性', factor: 'completeness' },
  { key: 'toolChoice', label: '工具选择', factor: 'tool_choice' },
  { key: 'redundancy', label: '冗余度', factor: 'redundancy' },
];

async function runTrajectoryQuality(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  const { evaluateTrajectoryViaOpencode } = await import('../evaluation/opencode-trajectory-evaluator');
  // 直连轨迹路径用的是 actualExtractedSteps/Text（预提取的扁平步骤），不是 actualInteractions。
  // 与 run route 的 buildTrajectoryTraceEvidence 同款：summarizeTrace → formatTraceForLLM → step_index 映射。
  const { summarizeTrace, formatTraceForLLM } = await import('../evaluation/trace-summarizer');
  const summary = summarizeTrace(ctx.interactions, { maxSteps: 80, maxTextLen: 400 });
  const extractedSteps = summary.steps.map((step) => ({ ...step, step_index: step.index, stepIndex: step.index }));

  // skill 归因：trace 用了 skill 且能取到关键动作参考 → skill_key_actions 模式（含 skill 改进建议），
  // 否则 trace_only。与评测执行 run route 一致，跟单组/对比无关。
  const { buildSkillKeyActionReference } = await import('../evaluation/key-action-trace-analysis');
  const keyActionRef = await buildSkillKeyActionReference(ctx.execution ?? null, ctx.user ?? user, ctx.interactions);
  const hasKeyActions = keyActionRef.status === 'ok' && extractedSteps.length > 0;

  const out = await evaluateTrajectoryViaOpencode(
    {
      caseId: ctx.executionId ?? ctx.taskId ?? 'exp-case',
      caseInput: ctx.caseInput,
      actualInteractions: ctx.interactions,
      actualExtractedSteps: extractedSteps,
      actualExtractedStepsText: formatTraceForLLM(summary),
      comparisonMode: hasKeyActions ? 'skill_key_actions' : 'trace_only',
      ...(hasKeyActions ? {
        referenceKeyActionsText: keyActionRef.referenceKeyActionsText,
        referenceKeyActions: keyActionRef.referenceKeyActions ?? [],
      } : {}),
      taskId: ctx.taskId ?? undefined,
      executionId: ctx.executionId ?? undefined,
    },
    user,
  );

  const dims = out.dimensionScores ?? { completeness: null, toolChoice: 0, redundancy: 0 };
  const deviations = Array.isArray(out.deviationSteps) ? out.deviationSteps : [];

  // 每维度说明文本：评估器 dimension_details[factor].explanation（无 deviation 明细时作为证据兜底，
  // 确保完整性/工具选择/冗余度三张评分点都带判断依据，而非空证据列）
  const rawDetails = (out.rawAnalysis && typeof out.rawAnalysis === 'object'
    ? (out.rawAnalysis as Record<string, unknown>).dimension_details
    : undefined);
  const explanationOf = (factor: string): string => {
    const d = rawDetails && typeof rawDetails === 'object' ? (rawDetails as Record<string, unknown>)[factor] : undefined;
    const ex = d && typeof d === 'object' ? (d as Record<string, unknown>).explanation : undefined;
    return typeof ex === 'string' ? ex.trim() : '';
  };

  // 关键动作覆盖明细——「完整性」分本就是这些 covered/partial/missing 覆盖判定的汇总，
  // 故拼进「完整性」的证据 md（与其它评分点证据统一的 markdown 呈现），而不是与三维度
  // 并列成独立评分点。
  const keyActions = Array.isArray(out.keyActionResults) ? out.keyActionResults : [];
  const COVERAGE_MARK: Record<EvalPointStatus, string> = {
    covered: '✅ 已覆盖', partial: '⚠️ 部分覆盖', missing: '❌ 未覆盖',
  };
  const kaLines: string[] = [];
  for (const ka of keyActions) {
    if (!ka || !ka.actionContent) continue;
    if (ka.coverage === 'not_applicable') continue;
    const status = coverageToStatus(ka.coverage);
    const mark = status ? COVERAGE_MARK[status] : '';
    const analysis = ka.traceComparisonAnalysis?.trim() ? ` —— ${ka.traceComparisonAnalysis.trim()}` : '';
    kaLines.push(`- ${mark} · **${String(ka.actionContent).trim()}**${analysis}`);
  }
  const keyActionMd = kaLines.length ? `**关键动作覆盖明细**\n${kaLines.join('\n')}` : '';

  // 固定三维度作为评分点，deviation 按 factor 归到对应维度，填 evidence/suggestion/anchors；
  // 完整性把关键动作覆盖明细拼进证据 md。
  const points: EvalPoint[] = DIM_LABELS.map(({ key, label, factor }) => {
    const dimDevs = deviations.filter((d) => (d.factor ?? 'other') === factor);
    const devMd = dimDevs.map((d) => `[${d.severity}] ${d.deviation}`).join('\n');
    let md = devMd || explanationOf(factor); // 优先 deviation 明细，否则该维度整体说明
    if (key === 'completeness' && keyActionMd) md = md ? `${md}\n\n${keyActionMd}` : keyActionMd;
    const attributable = dimDevs.find((d) => d.isSkillAttributable && d.improvementSuggestion);
    const anchors = dimDevs.map((d) => `step-${d.stepIndex}`).filter(Boolean);
    const pt: EvalPoint = { label };
    const sc = to100(dims[key]);
    if (sc !== undefined) pt.score = sc;
    if (md) pt.evidence = { md };
    if (attributable) {
      pt.skillAttributable = true;
      pt.suggestion = attributable.improvementSuggestion;
    }
    if (anchors.length) pt.anchors = anchors;
    return pt;
  }).filter((p) => p.score !== undefined || p.evidence); // 空维度（无分且无任何说明）才略去

  // 轨迹评估器没有 isCorrect 之类的达成判定，verdict 留空由呈现层按分数派生。
  // summary 取 conclusionText（说人话的一句话结论）；模型没给才回落 reasonText——
  // 后者是「执行路径分析」绿框的正文，带完整性/工具选择/冗余分段结构，当结论读着费劲。
  return normalizeEvaluatorOutput({
    summary: out.conclusionText || out.reasonText,
    score: to100(out.trajectoryScore),
    points: points.length ? points : undefined,
    evidence: out.reasonText ? { md: out.reasonText } : undefined,
  });
}
