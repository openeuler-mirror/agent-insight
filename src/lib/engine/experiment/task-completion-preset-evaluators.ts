/**
 * 任务完成度（无标准答案）评估器（LLM Judge）。
 *
 * 在无标准答案的情况下评估 Agent 任务的完成度，采用「需求推断 + 逐条对齐 + 置信度标记」三阶段方法。
 *
 * 评分点来自用户输入推断（而非参考答案），与 preset-agent-task-completion 正交。
 */
import { z } from 'zod';
import {
  normalizeEvaluatorOutput,
  type EvaluatorOutput,
  type EvalPoint,
  type EvalPointStatus,
} from '@/lib/evaluators/eval-output';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';

export const TASK_COMPLETION_NO_REF_PRESET_ID = 'preset-task-completion-no-ref';
export const TASK_COMPLETION_NO_REF_PRESET_IDS = [TASK_COMPLETION_NO_REF_PRESET_ID] as const;
export type TaskCompletionNoRefPresetId = (typeof TASK_COMPLETION_NO_REF_PRESET_IDS)[number];

export function isTaskCompletionNoRefPresetId(id: string): id is TaskCompletionNoRefPresetId {
  return (TASK_COMPLETION_NO_REF_PRESET_IDS as readonly string[]).includes(id);
}

// ── Judge Schema ──────────────────────────────────────────────────────────────

const requirementSchema = z.object({
  content: z.string().min(1),
  type: z.enum(['explicit', 'implicit', 'business_must_have']),
  confidence: z.enum(['high', 'medium', 'low']),
});

const requirementResultSchema = z.object({
  content: z.string().min(1),
  type: z.enum(['explicit', 'implicit', 'business_must_have']),
  confidence: z.enum(['high', 'medium', 'low']),
  verdict: z.enum(['covered', 'partially_covered', 'not_covered', 'not_applicable']),
  reason: z.string(),
});

const taskCompletionJudgeSchema = z.object({
  overall_reason: z.string().min(1),
  inferred_requirements: z.array(requirementSchema),
  requirement_results: z.array(requirementResultSchema),
  explicit_completion_score: z.number().min(0).max(100),
  implicit_constraint_score: z.number().min(0).max(100),
  information_sufficiency_score: z.number().min(0).max(100),
  overall_analysis: z.string(),
});

type TaskCompletionJudgeResult = z.infer<typeof taskCompletionJudgeSchema>;

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(ctx: FaithfulPresetContext): { system: string; user: string } {
  const system = `你是任务完成度评估专家。在无标准答案的情况下，你需要通过「需求推断 + 逐条对齐 + 置信度标记」三阶段方法评估 Agent 任务的完成度。

**第一阶段——需求推断**：从用户输入中推断出应该完成的要点清单，包括：
- explicit（显式需求）：用户明确提出的要求或问题
- implicit（隐含约束）：用户虽未明说但从语境中可推断出的限制条件
- business_must_have（业务必答点）：在该业务场景下必须覆盖的要素
每条需求标注 confidence：high（高置信度）/ medium（中置信度）/ low（低置信度）

**第二阶段——逐条对齐**：将 Agent 输出与推断出的需求清单逐条对比，判定：
- covered：Agent 输出明确满足了该需求
- partially_covered：部分满足但不够完整
- not_covered：未满足该需求
- not_applicable：推断的需求在当前上下文中不适用

**第三阶段——综合评分**，从以下三个维度计算：
1. **显式需求完成度**：所有显式需求的完成比例
2. **隐含约束满足度**：隐含的约束条件是否被满足（低置信度约束未满足扣分减半）
3. **信息充分性与中立性**：回答在信息量和立场上是否适当

关键判定规则：
- 开放式创作任务（如"写首诗"）只要生成了合理且符合体裁的内容即可高分
- 用户输入过于模糊时，合理地请求澄清是最佳回应
- 隐含了情绪需求的输入，应先回应情绪再解决问题
- 对于低置信度的隐含约束，即使未满足也不应严重扣分
- 多轮对话中正确利用上下文信息应予以肯定`;

  const user = `**用户输入**
${ctx.caseInput || '(未提供)'}

**Agent 输出**
${ctx.actualOutput || '(未提供)'}

请分析并返回 JSON：

\`\`\`json
{
  "overall_reason": "一句话总结任务完成情况",
  "inferred_requirements": [
    {
      "content": "需求内容描述",
      "type": "explicit/implicit/business_must_have",
      "confidence": "high/medium/low"
    }
  ],
  "requirement_results": [
    {
      "content": "需求内容（与 inferred_requirements 对应）",
      "type": "explicit/implicit/business_must_have",
      "confidence": "high/medium/low",
      "verdict": "covered/partially_covered/not_covered/not_applicable",
      "reason": "判定理由"
    }
  ],
  "explicit_completion_score": 0-100,
  "implicit_constraint_score": 0-100,
  "information_sufficiency_score": 0-100,
  "overall_analysis": "综合分析说明"
}
\`\`\``;

  return { system, user };
}

// ── 计分逻辑 ──────────────────────────────────────────────────────────────────

/**
 * 按规格计算得分（代码控制，不让 LLM 自由打 0-100）。
 *
 * 规则：
 * - 显式需求每遗漏一条扣 20（规格 15~25 取中值），最低 0
 * - 隐含约束：低置信度未满足扣分减半
 * - 信息充分性：LLM 离散判断（充分/基本充分/不足/明显不足）→ 固定分数
 * - 最终加权：显式 0.5 + 隐含 0.3 + 信息充分性 0.2
 */
function computeScore(judge: TaskCompletionJudgeResult): {
  score: number;
  points: EvalPoint[];
  summary: string;
  reason: string;
  verdict: 'pass' | 'warn' | 'fail';
} {
  const allReqs = judge.requirement_results;

  // 显式需求：每遗漏一条扣 20，partial 扣 10；全部未覆盖直接 0
  const explicitReqs = allReqs.filter((r) => r.type === 'explicit' || r.type === 'business_must_have');
  const notCoveredExplicit = explicitReqs.filter((r) => r.verdict === 'not_covered').length;
  const partialExplicit = explicitReqs.filter((r) => r.verdict === 'partially_covered').length;
  const allExplicitNotCovered = explicitReqs.length > 0 && notCoveredExplicit === explicitReqs.length;
  const explicitScore = allExplicitNotCovered
    ? 0
    : explicitReqs.length === 0
      ? 100
      : Math.max(0, 100 - notCoveredExplicit * 20 - partialExplicit * 10);

  // 隐含约束：低置信度未满足扣 10，高/中置信度未满足扣 20，partial 扣 10
  const implicitReqs = allReqs.filter((r) => r.type === 'implicit');
  let implicitDeduction = 0;
  for (const r of implicitReqs) {
    if (r.verdict === 'not_covered') {
      implicitDeduction += r.confidence === 'low' ? 10 : 20;
    } else if (r.verdict === 'partially_covered') {
      implicitDeduction += 10;
    }
  }
  const implicitScore = implicitReqs.length === 0 ? 100 : Math.max(0, 100 - implicitDeduction);

  // 信息充分性：LLM 已给 score，直接用
  const infoScore = judge.information_sufficiency_score;

  // 加权总分
  const score = Math.round(explicitScore * 0.5 + implicitScore * 0.3 + infoScore * 0.2);

  const verdict: 'pass' | 'warn' | 'fail' = score >= 80 ? 'pass' : (score >= 60 ? 'warn' : 'fail');

  // reason：需求推断清单 + 逐条判定（含置信度标记） + 综合评分说明（规格要求）
  const allResults = judge.requirement_results;
  const reasonParts: string[] = [];

  reasonParts.push('## 需求推断与逐条判定');
  reasonParts.push('');
  const typeLabel: Record<string, string> = { explicit: '显式需求', implicit: '隐含约束', business_must_have: '业务必答点' };
  for (const r of allResults) {
    const typeName = typeLabel[r.type] || r.type;
    const conf = r.confidence !== 'high' ? ` (置信度: ${r.confidence})` : '';
    const mark = verdictMark(r.verdict);
    reasonParts.push(`- ${mark} [${typeName}]${conf} ${r.content} —— ${r.reason}`);
  }

  reasonParts.push('');
  reasonParts.push('## 综合评分');
  reasonParts.push(`- 显式需求完成度: ${explicitScore} (权重 0.5)`);
  reasonParts.push(`- 隐含约束满足度: ${implicitScore} (权重 0.3)`);
  reasonParts.push(`- 信息充分性: ${infoScore} (权重 0.2)`);
  reasonParts.push(`- 加权总分: ${score}`);

  const reason = reasonParts.join('\n');

  // summary：说人话，≤80 字，讲最要命的具体问题（开发指南 §2.1）
  const notCovered = judge.requirement_results.filter((r) => r.verdict === 'not_covered');
  const partial = judge.requirement_results.filter((r) => r.verdict === 'partially_covered');
  let summary: string;
  if (notCovered.length === 0 && partial.length === 0) {
    summary = `全部 ${allResults.length} 项需求均已满足。`.slice(0, 80);
  } else if (notCovered.length > 0) {
    const names = notCovered.slice(0, 3).map((r) => r.content).join('、');
    summary = `未满足：${names}${notCovered.length > 3 ? `等 ${notCovered.length} 项` : ''}。`.slice(0, 80);
  } else {
    const names = partial.slice(0, 3).map((r) => r.content).join('、');
    summary = `部分满足：${names}${partial.length > 3 ? `等 ${partial.length} 项` : ''}。`.slice(0, 80);
  }

  const points: EvalPoint[] = [];

  // 评分点1：显式需求完成度（包含 explicit + business_must_have）
  const allExplicitReqs = judge.requirement_results.filter(
    (r) => r.type === 'explicit' || r.type === 'business_must_have',
  );
  if (allExplicitReqs.length > 0) {
    const lines = allExplicitReqs.map((r) => {
      const tag = r.type === 'business_must_have' ? ' [业务必答点]' : '';
      const conf = r.confidence !== 'high' ? ` [置信度: ${r.confidence}]` : '';
      const mark = verdictMark(r.verdict);
      return `- ${mark} ${r.content}${tag}${conf} —— ${r.reason}`;
    });
    points.push({
      label: '显式需求完成度',
      score: explicitScore,
      status: scoreToStatus(explicitScore),
      evidence: { md: lines.join('\n') },
    });
  }

  // 评分点2：隐含约束满足度（始终展示，无隐含约束时显示「无」提示）
  const implicitLines = implicitReqs.length > 0
    ? implicitReqs.map((r) => {
      const conf = r.confidence !== 'high' ? ` [置信度: ${r.confidence}]` : '';
      const mark = verdictMark(r.verdict);
      return `- ${mark} ${r.content}${conf} —— ${r.reason}`;
    }).join('\n')
    : '本次任务未推断出隐含约束。';
  points.push({
    label: '隐含约束满足度',
    score: implicitScore,
    status: implicitReqs.length === 0 ? 'covered' : scoreToStatus(implicitScore),
    evidence: { md: implicitLines },
  });

  // 评分点3：信息充分性与中立性
  points.push({
    label: '信息充分性与中立性',
    score: infoScore,
    status: scoreToStatus(infoScore),
    evidence: { md: judge.overall_analysis },
  });

  return { score, points, summary, reason, verdict };
}

function verdictMark(v: string): string {
  switch (v) {
    case 'covered': return '✅';
    case 'partially_covered': return '⚠️';
    case 'not_covered': return '❌';
    case 'not_applicable': return '—';
    default: return '?';
  }
}

function scoreToStatus(s: number): EvalPointStatus {
  if (s >= 80) return 'covered';
  if (s >= 60) return 'partial';
  return 'missing';
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export async function runTaskCompletionNoRefPreset(
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  const prompt = buildPrompt(ctx);

  const { callJudgeLlm } = await import('./judge-llm');
  const rawText = await callJudgeLlm(user, {
    system: prompt.system,
    user: prompt.user,
    sessionTitle: 'task-completion-no-ref-judge',
  });

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

  const result = taskCompletionJudgeSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new JudgeOutputParseError(`judge 输出不符合契约: ${details}`, rawText);
  }

  const { score, points, summary, reason, verdict } = computeScore(result.data);

  return normalizeEvaluatorOutput({
    verdict,
    summary,
    score,
    points: points.length ? points : undefined,
    evidence: {
      md: reason,
      json: {
        rubricVersion: '1.0.0',
        explicitCompletionScore: result.data.explicit_completion_score,
        implicitConstraintScore: result.data.implicit_constraint_score,
        informationSufficiencyScore: result.data.information_sufficiency_score,
        requirements: result.data.requirement_results,
      },
    },
  });
}

// ── 测试注入点 ────────────────────────────────────────────────────────────────

type TaskCompletionRunner = (user: string, ctx: FaithfulPresetContext) => Promise<EvaluatorOutput>;
let testRunner: TaskCompletionRunner | null = null;
export function setTaskCompletionNoRefRunnerForTest(fn: TaskCompletionRunner | null): void {
  testRunner = fn;
}

// 注：实际分发在 run-experiment.ts 的 evaluateOnce() 中通过 isTaskCompletionNoRefPresetId 判断，
// 测试注入通过本模块的 testRunner 变量实现，允许测试绕过真实 LLM 调用。
// runTaskCompletionNoRefPreset 在测试模式下使用 testRunner，生产模式下直接调用 judge-llm。
export async function runTaskCompletionNoRef(
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  if (testRunner) return testRunner(user, ctx);
  return runTaskCompletionNoRefPreset(user, ctx);
}
