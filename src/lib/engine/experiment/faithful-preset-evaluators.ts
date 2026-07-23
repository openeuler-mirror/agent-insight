/**
 * 忠实版预置 LLM 评估器：让实验的
 *   preset-agent-task-completion / preset-agent-trace-quality
 * 复用「评测执行」原有的 opencode 评估器逻辑（四固定维度 / 关键观点 / skill 归因 /
 * deviation 步骤），而非通用三段式简化版——保证口径与评测执行一致、并为 skill 优化
 * 闭环产出归因字段（status / skillAttributable / suggestion / anchors）。
 *
 * 原评估器输出为 0-1 量纲；本模块映射到统一契约（0-100，见 eval-output.ts），
 * 最终统一过 normalizeEvaluatorOutput 兜底。
 */
// 原 opencode 评估器传递依赖 @opencode-ai/sdk（server-only，node --test 无法静态加载）。
// 与 judge-llm.ts 同策略：惰性 import()，运行时才加载——测试注入/纯函数校验时零加载。
import { normalizeEvaluatorOutput, type EvaluatorOutput, type EvalPoint, type EvalPointStatus } from '../../evaluators/eval-output';

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
  taskId: string | null;
  executionId: string | null;
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
  const out = await evaluateTaskCompletionViaOpencode(
    {
      caseInput: ctx.caseInput,
      expectedOutput: ctx.referenceOutput ?? '',
      actualOutput: ctx.actualOutput,
      traceSummaryText: ctx.traceSummaryText ?? undefined,
      // 实验单组本期无 skill 上下文——走无 Skill 分支（禁止输出 skill 归因）
      skillAttributionMode: 'no-skill',
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

  return normalizeEvaluatorOutput({
    score: to100(out.score),
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
  const out = await evaluateTrajectoryViaOpencode(
    {
      caseId: ctx.executionId ?? ctx.taskId ?? 'exp-case',
      caseInput: ctx.caseInput,
      actualInteractions: ctx.interactions,
      comparisonMode: 'trace_only',
      taskId: ctx.taskId ?? undefined,
      executionId: ctx.executionId ?? undefined,
    },
    user,
  );

  const dims = out.dimensionScores ?? { completeness: null, toolChoice: 0, redundancy: 0 };
  const deviations = Array.isArray(out.deviationSteps) ? out.deviationSteps : [];

  // 固定三维度作为评分点，deviation 按 factor 归到对应维度，填 evidence/suggestion/anchors
  const points: EvalPoint[] = DIM_LABELS.map(({ key, label, factor }) => {
    const dimDevs = deviations.filter((d) => (d.factor ?? 'other') === factor);
    const md = dimDevs.map((d) => `[${d.severity}] ${d.deviation}`).join('\n');
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
  }).filter((p) => p.score !== undefined || p.evidence); // 完整性可能为 null 且无 deviation → 略去空维度

  // keyActionResults（有参考关键观点时）追加为评分点，携带 coverage/skill 建议
  const keyActions = Array.isArray(out.keyActionResults) ? out.keyActionResults : [];
  for (const ka of keyActions) {
    if (!ka || !ka.actionContent) continue;
    const status = coverageToStatus(ka.coverage);
    if (ka.coverage === 'not_applicable') continue;
    const anchors = Array.isArray(ka.matchedTraceSteps)
      ? ka.matchedTraceSteps.map((n) => `step-${n}`) : undefined;
    points.push({
      label: String(ka.actionContent).slice(0, 120),
      ...(status ? { status } : {}),
      ...(ka.hasSkillImprovement ? { skillAttributable: true } : {}),
      ...(ka.skillImprovementSuggestion?.trim() ? { suggestion: ka.skillImprovementSuggestion.trim() } : {}),
      ...(ka.traceComparisonAnalysis ? { evidence: { md: ka.traceComparisonAnalysis } } : {}),
      ...(anchors && anchors.length ? { anchors } : {}),
    });
  }

  return normalizeEvaluatorOutput({
    score: to100(out.trajectoryScore),
    points: points.length ? points : undefined,
    evidence: out.reasonText ? { md: out.reasonText } : undefined,
  });
}
