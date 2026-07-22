/**
 * 预置代码评估器 ×5：工具调用可靠性 / 时延预算 / 成本预算 / 冗余循环检测 / Token 效率。
 *
 * 独立能力单元：输入为引擎侧从 Execution（及可选的 interactions 工具序列）预提取的
 * CodeEvalContext，输出统一契约 EvaluatorOutput（见 eval-output.ts）。
 * 纯函数、零配置、不依赖参考数据；预算阈值集中在 CODE_EVAL_BUDGETS（后续可做成实验级配置）。
 *
 * 口径与监控侧一致（硬错误 = toolCallErrorCount/failures；成本 = 模型单价加权，
 * 由引擎用 rowCost 预先算好传入）。缺数据时诚实返回"无分"（只有 evidence，无 score）——
 * 按契约不入均分，而不是错误地记 0 分。
 */
import type { EvaluatorOutput } from './eval-output';

export interface CodeEvalContext {
  latencySec?: number | null;
  toolCallCount?: number | null;
  toolCallErrorCount?: number | null;
  llmCallCount?: number | null;
  totalTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  maxSingleCallTokens?: number | null;
  model?: string | null;
  /** 引擎侧按单价加权预先算好；单价缺失时传 null 并置 costMissing */
  costUsd?: number | null;
  costMissing?: boolean;
  /** Execution.failures 解析后的摘要（工具/步骤名列表，引擎侧截断） */
  failureSummaries?: string[];
  /** 按执行顺序的工具名序列（interactions 提取；缺省时冗余检测降级为无分） */
  toolCallNames?: string[];
}

/** 预算阈值（v1 全局默认；做成实验级配置是后续项，不阻塞契约） */
export const CODE_EVAL_BUDGETS = {
  latencySec: 60,
  costUsd: 0.1,
  tokensPerTask: 60_000,
};

export const CODE_EVALUATOR_IDS = [
  'preset-code-tool-reliability',
  'preset-code-latency-budget',
  'preset-code-cost-budget',
  'preset-code-redundancy-loop',
  'preset-code-token-efficiency',
] as const;
export type CodeEvaluatorId = (typeof CODE_EVALUATOR_IDS)[number];

export function isCodeEvaluatorId(id: string): id is CodeEvaluatorId {
  return (CODE_EVALUATOR_IDS as readonly string[]).includes(id);
}

/** 统一入口：按评估器 id 分发；未知 id 返回 null。 */
export function runCodeEvaluator(id: string, ctx: CodeEvalContext): EvaluatorOutput | null {
  switch (id) {
    case 'preset-code-tool-reliability': return evalToolReliability(ctx);
    case 'preset-code-latency-budget': return evalLatencyBudget(ctx);
    case 'preset-code-cost-budget': return evalCostBudget(ctx);
    case 'preset-code-redundancy-loop': return evalRedundancyLoop(ctx);
    case 'preset-code-token-efficiency': return evalTokenEfficiency(ctx);
    default: return null;
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const clamp = (n: number) => Math.min(100, Math.max(0, r1(n)));

/** 工具调用可靠性：score = (1 − 错误率) × 100（硬错误口径）。 */
function evalToolReliability(ctx: CodeEvalContext): EvaluatorOutput {
  const calls = ctx.toolCallCount ?? null;
  if (calls === null) {
    return { evidence: { md: '该 trace 无工具调用统计数据，无法评估——不记分。' } };
  }
  if (calls === 0) {
    return { score: 100, evidence: { md: '该 trace 未发生工具调用，无失败项。' } };
  }
  const errs = ctx.toolCallErrorCount ?? 0;
  const errorRatePct = r1((errs / calls) * 100);
  return {
    score: clamp((1 - errs / calls) * 100),
    evidence: {
      json: {
        toolCalls: calls,
        toolErrors: errs,
        errorRatePct,
        failures: (ctx.failureSummaries ?? []).slice(0, 20),
      },
    },
  };
}

/** 时延预算：预算内满分；超预算按 预算/实际 比例衰减。 */
function evalLatencyBudget(ctx: CodeEvalContext): EvaluatorOutput {
  const lat = ctx.latencySec ?? null;
  const budget = CODE_EVAL_BUDGETS.latencySec;
  if (lat === null || lat <= 0) {
    return { evidence: { md: '该 trace 无端到端耗时数据，无法评估——不记分。' } };
  }
  const over = lat > budget;
  return {
    score: over ? clamp((budget / lat) * 100) : 100,
    evidence: {
      json: {
        latencySec: r1(lat),
        budgetSec: budget,
        ...(over ? { overBudgetPct: r1(((lat - budget) / budget) * 100) } : {}),
      },
    },
  };
}

/** 成本预算：单价加权成本对照预算；单价缺失诚实无分（不错记 0 成本=满分）。 */
function evalCostBudget(ctx: CodeEvalContext): EvaluatorOutput {
  if (ctx.costMissing || ctx.costUsd === null || ctx.costUsd === undefined) {
    return {
      evidence: {
        md: `无法计算该 trace 成本（模型 ${ctx.model ?? '未知'} 缺单价或无用量数据）——不记分。可在 custom-models.json 补充单价。`,
      },
    };
  }
  const budget = CODE_EVAL_BUDGETS.costUsd;
  const cost = ctx.costUsd;
  const over = cost > budget;
  return {
    score: cost === 0 ? 100 : over ? clamp((budget / cost) * 100) : 100,
    evidence: {
      json: {
        costUsd: Math.round(cost * 10000) / 10000,
        budgetUsd: budget,
        model: ctx.model ?? undefined,
        inputTokens: ctx.inputTokens ?? undefined,
        outputTokens: ctx.outputTokens ?? undefined,
      },
    },
  };
}

/** 冗余循环检测：连续同名调用（run≥3）+ 高频调用（总次数≥5），按冗余步占比给分。 */
function evalRedundancyLoop(ctx: CodeEvalContext): EvaluatorOutput {
  const names = ctx.toolCallNames;
  if (!names || names.length === 0) {
    return { evidence: { md: '该 trace 无工具调用序列数据（或未发生工具调用），无法检测冗余——不记分。' } };
  }
  // 连续同名 run
  const runs: Array<{ name: string; count: number; from: number; to: number }> = [];
  let start = 0;
  for (let i = 1; i <= names.length; i++) {
    if (i === names.length || names[i] !== names[start]) {
      if (i - start >= 3) runs.push({ name: names[start], count: i - start, from: start + 1, to: i });
      start = i;
    }
  }
  // 高频调用
  const freq = new Map<string, number>();
  for (const n of names) freq.set(n, (freq.get(n) ?? 0) + 1);
  const heavy = [...freq]
    .filter(([, c]) => c >= 5)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const redundantSteps = runs.reduce((a, x) => a + (x.count - 1), 0);
  return {
    score: clamp((1 - redundantSteps / names.length) * 100),
    evidence: {
      json: {
        totalToolCalls: names.length,
        redundantSteps,
        consecutiveSameRuns: runs.slice(0, 10),
        heavyRepeatedCalls: heavy.slice(0, 10),
      },
    },
  };
}

/** Token 效率：单位任务 token 对照基线；同时暴露单次最大调用（上下文膨胀线索）。 */
function evalTokenEfficiency(ctx: CodeEvalContext): EvaluatorOutput {
  const total = ctx.totalTokens ?? null;
  if (total === null || total <= 0) {
    return { evidence: { md: '该 trace 无 token 用量数据，无法评估——不记分。' } };
  }
  const baseline = CODE_EVAL_BUDGETS.tokensPerTask;
  const llmCalls = ctx.llmCallCount ?? null;
  const over = total > baseline;
  return {
    score: over ? clamp((baseline / total) * 100) : 100,
    evidence: {
      json: {
        totalTokens: total,
        baselineTokens: baseline,
        llmCalls: llmCalls ?? undefined,
        avgTokensPerCall: llmCalls ? Math.round(total / llmCalls) : undefined,
        maxSingleCallTokens: ctx.maxSingleCallTokens ?? undefined,
      },
    },
  };
}
