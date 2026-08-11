/**
 * Agent 工具调用成功率评估器（代码统计 + LLM 离散判断）。
 *
 * 评估 Agent 执行过程中工具调用的成功率，从四个维度分析：
 * 1. 整体成功率 —— 代码从轨迹确定性统计
 * 2. 按工具聚合失败率 —— 代码从轨迹确定性统计
 * 3. 错误模式分析 —— LLM 离散判断（按错误类型聚合）
 * 4. 失败影响评估 —— LLM 离散判断（severe/moderate/minor/none 四档）
 *
 * 计分：代码固定公式，LLM 不做连续打分（遵循开发指南 §3.1/§3.2）。
 * 依赖 evaluatorContext 中的 availableTools，以及 interactions 中的调用事实。
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
import { listEvaluatorCapabilities } from '@/lib/evaluators/evaluator-case-context';
import { extractToolTraceFacts, type ToolTraceFacts } from './agent-tool-trace-facts';
import { isFailedCallStatus, SPECIALIZED_RUBRIC_VERSION } from './specialized-evaluator-common';

export const TOOL_SUCCESS_RATE_PRESET_ID = 'preset-agent-tool-success-rate';

// ── 确定性统计（代码算，不让 LLM 算）──────────────────────────────────────────

interface PerToolStats {
  toolName: string;
  total: number;
  success: number;
  fail: number;
  failureRatePct: number;
}

interface TraceStats {
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  overallSuccessRate: number; // 0-100
  perTool: PerToolStats[];
}

function computeTraceStats(facts: ToolTraceFacts): TraceStats {
  const totalCalls = facts.calls.length;
  const successfulCalls = facts.calls.filter((c) => !isFailedCallStatus(c.status)).length;
  const failedCalls = totalCalls - successfulCalls;
  const overallSuccessRate = totalCalls === 0 ? 100 : Math.round((successfulCalls / totalCalls) * 100);

  const byTool = new Map<string, { total: number; success: number; fail: number }>();
  for (const call of facts.calls) {
    const key = call.canonicalName || call.name;
    const entry = byTool.get(key) ?? { total: 0, success: 0, fail: 0 };
    entry.total++;
    if (isFailedCallStatus(call.status)) {
      entry.fail++;
    } else {
      entry.success++;
    }
    byTool.set(key, entry);
  }
  const perTool: PerToolStats[] = [...byTool.entries()]
    .map(([toolName, s]) => ({
      toolName,
      total: s.total,
      success: s.success,
      fail: s.fail,
      failureRatePct: s.total === 0 ? 0 : Math.round((s.fail / s.total) * 100),
    }))
    .sort((a, b) => b.failureRatePct - a.failureRatePct || b.total - a.total);

  return { totalCalls, successfulCalls, failedCalls, overallSuccessRate, perTool };
}

// ── LLM Judge Schema（只做离散判断）─────────────────────────────────────────────

const errorPatternSchema = z.object({
  error_code: z.string().min(1),
  tool_name: z.string().min(1),
  count: z.number().int().min(1),
  pattern: z.string().min(1),
});

const failureImpactSchema = z.object({
  critical_path_failures: z.boolean(),
  critical_path_details: z.string().optional(),
  retry_recovery_count: z.number().int().min(0),
  wasted_token_estimate: z.string().optional(),
  impact_verdict: z.enum(['severe', 'moderate', 'minor', 'none']),
});

const successRateJudgeSchema = z.object({
  error_patterns: z.array(errorPatternSchema).default([]),
  failure_impact: failureImpactSchema,
});

type SuccessRateJudgeResult = z.infer<typeof successRateJudgeSchema>;

// ── Prompt（LLM 只做离散判断：错误模式 + 失败影响）─────────────────────────────

function buildPrompt(
  ctx: FaithfulPresetContext,
  facts: ToolTraceFacts,
  stats: TraceStats,
): { system: string; user: string } {
  const capabilities = ctx.evaluatorContext
    ? listEvaluatorCapabilities(ctx.evaluatorContext)
    : [];
  const catalogLines = capabilities.map((c) => `- [${c.kind}] ${c.name}`).join('\n');

  // 确定性统计结果（LLM 不需要算，只需读）
  const callLines = facts.calls.map((call, i) => {
    const name = call.name;
    const failed = isFailedCallStatus(call.status);
    const label = failed ? `失败 (状态: ${call.status ?? 'unknown'})` : '成功';
    return `${i + 1}. ${name}: ${label}`;
  }).join('\n');

  const perToolLines = stats.perTool.map(
    (t) => `- ${t.toolName}: ${t.success}/${t.total} (失败率 ${t.failureRatePct}%)`,
  ).join('\n');

  const system = `你是 Agent 工具调用轨迹的分析专家。你的任务是**只做离散判断**，不要给连续分数。

评估维度（只做下面两项）：
1. **错误模式分析**：按错误类型和错误码聚合分析失败原因。
   - 同一工具反复因同一错误码失败 → 说明 Agent 未做改进
   - 多种不同的错误码指向不同的失败原因
   - 网络超时类错误占比过高 → 基础设施问题
   - 参数错误类失败 → Agent 参数填充逻辑问题
2. **失败影响评估**：评估工具调用失败对整体任务的影响程度。
   - 关键路径上的工具失败导致任务中断 → severe
   - 部分核心步骤失败但任务可补救 → moderate
   - 非关键工具失败，不影响核心任务 → minor
   - 无任何失败或全部可忽略 → none
   - 降级策略有效（主路径失败但备份路径成功）→ 应记为 minor 而非 severe
   - 重试后成功不应视为严重失败

关键判定规则：
- 致命失败（导致任务中断）比非致命失败（可重试或绕过）严重得多
- 相同错误反复出现说明 Agent 未做改进
- 重试后成功不应视为严重失败，但需记录额外耗时
- 失败集中在非关键路径不应严重扣分
- 降级策略有效应予以肯定`;

  const catalogBlock = catalogLines.length > 0
    ? `**可用工具目录**\n${catalogLines}\n\n`
    : '';
  const user = `${catalogBlock}**Agent 运行轨迹（工具调用步骤与错误码信息）**
${callLines || '(无工具调用)'}

**确定性统计（代码已计算，无需重复）**
- 总调用: ${stats.totalCalls}, 成功: ${stats.successfulCalls}, 失败: ${stats.failedCalls}
- 整体成功率: ${stats.overallSuccessRate}%
- 按工具聚合:
${perToolLines || '(无)'}

请分析并返回 JSON（只做离散判断，不要给连续分）：

\`\`\`json
{
  "error_patterns": [
    {
      "error_code": "错误码",
      "tool_name": "关联工具",
      "count": 出现次数,
      "pattern": "错误模式描述"
    }
  ],
  "failure_impact": {
    "critical_path_failures": true/false,
    "critical_path_details": "关键路径失败详情（可选）",
    "retry_recovery_count": 重试恢复次数,
    "wasted_token_estimate": "浪费的 Token 估算（可选）",
    "impact_verdict": "severe/moderate/minor/none"
  }
}
\`\`\``;

  return { system, user };
}

// ── 计分逻辑（固定公式）───────────────────────────────────────────────────────

const IMPACT_WEIGHT: Record<string, number> = { severe: 30, moderate: 20, minor: 10, none: 0 };

function computeScore(
  judge: SuccessRateJudgeResult,
  stats: TraceStats,
): {
  score: number;
  points: EvalPoint[];
  summary: string;
  reason: string;
  verdict: 'pass' | 'warn' | 'fail';
} {
  let score = 100;

  // 1. 整体成功率扣分：每降 10% 扣 10，最低扣至 50
  if (stats.overallSuccessRate < 100) {
    const deficit = 100 - stats.overallSuccessRate;
    const deduction = Math.floor(deficit / 10) * 10;
    score = Math.max(50, score - deduction);
  }

  // 2. 关键路径失败 + 失败影响：severe=30 / moderate=20 / minor=10 / none=0
  const impact = judge.failure_impact;
  if (impact.critical_path_failures) {
    score -= IMPACT_WEIGHT[impact.impact_verdict] || 0;
  }

  // 3. 相同错误重复出现（≥3 次）扣 10；与 severe 关键路径失败互斥（避免双重扣分）
  const repeatedErrors = judge.error_patterns.filter((p) => p.count >= 3);
  const severeAlreadyCharged = impact.critical_path_failures && impact.impact_verdict === 'severe';
  if (repeatedErrors.length > 0 && !severeAlreadyCharged) {
    score -= 10;
  }

  score = Math.max(0, Math.min(100, score));

  // verdict
  let verdict: 'pass' | 'warn' | 'fail';
  if (score >= 80) verdict = 'pass';
  else if (score >= 60) verdict = 'warn';
  else verdict = 'fail';

  // summary：简洁结论（≤80 字）
  const failed = stats.failedCalls;
  const rate = stats.overallSuccessRate;
  let summary: string;
  if (failed === 0) {
    summary = `全部 ${stats.totalCalls} 次工具调用均成功。`;
  } else if (rate < 50) {
    summary = `${stats.totalCalls} 次调用中 ${failed} 次失败（成功率 ${rate}%），工具链路严重不稳定。`;
  } else if (impact.impact_verdict === 'severe') {
    summary = `关键路径工具调用失败导致任务中断：${impact.critical_path_details || '成功率 ' + rate + '%'}。`;
  } else if (repeatedErrors.length > 0) {
    const first = repeatedErrors[0];
    summary = `${first.tool_name} 反复因 ${first.error_code} 失败 ${first.count} 次，Agent 未做修复。`;
  } else if (rate < 80) {
    summary = `${stats.totalCalls} 次调用中 ${failed} 次失败（成功率 ${rate}%），部分步骤未完成。`;
  } else {
    summary = `${stats.totalCalls} 次调用中 ${failed} 次失败（成功率 ${rate}%），整体可用。`;
  }

  // reason：整体成功率统计 + 各工具成功率表格 + 错误模式聚合 + 失败影响（规格要求）
  const reasonParts: string[] = [];
  reasonParts.push(`## 整体成功率\n${stats.overallSuccessRate}% (${stats.successfulCalls}/${stats.totalCalls})`);

  if (stats.perTool.length > 0) {
    reasonParts.push(`\n## 各工具成功率\n${stats.perTool.map((t) => `- ${t.toolName}: ${t.success}/${t.total} (失败率 ${t.failureRatePct}%)`).join('\n')}`);
  }

  if (judge.error_patterns.length > 0) {
    reasonParts.push(`\n## 错误模式聚合\n${judge.error_patterns.map((e) => `- ${e.error_code} (${e.tool_name}): ${e.count}次 — ${e.pattern}`).join('\n')}`);
  }

  const impactSummary = judge.failure_impact;
  reasonParts.push(`\n## 失败影响分析\n- 影响判定: ${impactSummary.impact_verdict}`);
  if (impactSummary.critical_path_failures) {
    reasonParts.push(`- 关键路径失败: ${impactSummary.critical_path_details || '是'}`);
  }
  reasonParts.push(`- 重试恢复: ${impactSummary.retry_recovery_count} 次`);
  if (impactSummary.wasted_token_estimate) {
    reasonParts.push(`- Token 浪费: ${impactSummary.wasted_token_estimate}`);
  }
  const reason = reasonParts.join('\n');

  // points
  const points: EvalPoint[] = [];

  // 评分点1：整体成功率
  const overallRate = stats.overallSuccessRate;
  let rateStatus: EvalPointStatus;
  if (overallRate >= 80) rateStatus = 'covered';
  else if (overallRate >= 60) rateStatus = 'partial';
  else rateStatus = 'missing';
  points.push({
    label: '整体成功率',
    score: overallRate,
    status: rateStatus,
    evidence: {
      md: `**${stats.successfulCalls}/${stats.totalCalls} 成功** (${overallRate}%)`,
    },
  });

  // 评分点2：按工具聚合（取最高失败率工具判定）
  if (stats.perTool.length > 0) {
    const lines = stats.perTool.map((t) => {
      let prefix: string;
      if (t.failureRatePct > 50) prefix = '🔴';
      else if (t.failureRatePct > 0) prefix = '🟡';
      else prefix = '🟢';
      return `- ${prefix} **${t.toolName}**: ${t.success}/${t.total} (失败率 ${t.failureRatePct}%)`;
    });
    const maxFailureRate = Math.max(...stats.perTool.map((t) => t.failureRatePct));
    let perToolScore: number;
    if (maxFailureRate > 50) perToolScore = 50;
    else if (maxFailureRate > 20) perToolScore = 70;
    else perToolScore = 100;
    let perToolStatus: EvalPointStatus;
    if (maxFailureRate > 50) perToolStatus = 'missing';
    else if (maxFailureRate > 20) perToolStatus = 'partial';
    else perToolStatus = 'covered';
    points.push({
      label: '按工具聚合失败率',
      score: perToolScore,
      status: perToolStatus,
      evidence: { md: lines.join('\n') },
    });
  }

  // 评分点3：错误模式（始终展示，无错误时显示「无」提示）
  const errorLines = judge.error_patterns.length > 0
    ? judge.error_patterns.map(
      (e) => `- **${e.error_code}** (${e.tool_name}): ${e.count} 次 —— ${e.pattern}`,
    ).join('\n')
    : '本次执行未识别出错误模式。';
  const hasRepeatedErrors = judge.error_patterns.some((e) => e.count >= 3);
  const errorScore = judge.error_patterns.length === 0 ? 100
    : (hasRepeatedErrors ? 50 : 70);
  let errorStatus: EvalPointStatus;
  if (judge.error_patterns.length === 0) errorStatus = 'covered';
  else if (hasRepeatedErrors) errorStatus = 'missing';
  else errorStatus = 'partial';
  points.push({
    label: '错误模式分析',
    score: errorScore,
    status: errorStatus,
    evidence: { md: errorLines },
  });

  // 评分点4：失败影响（LLM 判断）
  const impactForPoint = judge.failure_impact;
  const impLines: string[] = [];
  if (impactForPoint.critical_path_failures) {
    impLines.push(`- ⚠️ 关键路径失败: ${impactForPoint.critical_path_details || '是'}`);
  }
  impLines.push(`- 重试恢复: ${impactForPoint.retry_recovery_count} 次`);
  if (impactForPoint.wasted_token_estimate) {
    impLines.push(`- Token 浪费: ${impactForPoint.wasted_token_estimate}`);
  }
  impLines.push(`- 影响判定: ${impactForPoint.impact_verdict}`);
  let impactScore: number;
  switch (impactForPoint.impact_verdict) {
    case 'none': impactScore = 100; break;
    case 'minor': impactScore = 80; break;
    case 'moderate': impactScore = 50; break;
    default: impactScore = 20;
  }
  let impactStatus: EvalPointStatus;
  if (impactForPoint.impact_verdict === 'none') impactStatus = 'covered';
  else if (impactForPoint.impact_verdict === 'minor') impactStatus = 'partial';
  else impactStatus = 'missing';
  points.push({
    label: '失败影响评估',
    score: impactScore,
    status: impactStatus,
    evidence: { md: impLines.join('\n') },
  });

  return { score, points, summary, reason, verdict };
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export async function runToolSuccessRatePreset(
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  const capabilities = ctx.evaluatorContext
    ? listEvaluatorCapabilities(ctx.evaluatorContext)
    : [];
  const facts = extractToolTraceFacts(ctx.interactions, capabilities);

  if (facts.calls.length === 0) {
    return normalizeEvaluatorOutput({
      verdict: 'pass',
      summary: '本次执行无工具调用。',
      score: 100,
      points: [{
        label: '整体成功率',
        score: 100,
        status: 'covered',
        evidence: { md: '无工具调用，跳过成功率评估。' },
      }],
      evidence: { md: '无工具调用，跳过成功率评估。' },
    });
  }

  // 1. 代码确定性统计成功率
  const stats = computeTraceStats(facts);

  // 2. LLM 离散判断：错误模式 + 失败影响
  const prompt = buildPrompt(ctx, facts, stats);
  const { callJudgeLlm } = await import('./judge-llm');
  const rawText = await callJudgeLlm(user, {
    system: prompt.system,
    user: prompt.user,
    sessionTitle: 'tool-success-rate-judge',
  });

  // 解析 JSON
  const text = rawText.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new JudgeOutputParseError('工具成功率 judge 输出中未找到 JSON 对象', rawText);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new JudgeOutputParseError(
      `工具成功率 judge JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`,
      rawText,
    );
  }
  const result = successRateJudgeSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new JudgeOutputParseError(`工具成功率 judge 输出不符合契约: ${details}`, rawText);
  }

  const { score, points, summary, reason, verdict } = computeScore(result.data, stats);

  return normalizeEvaluatorOutput({
    verdict,
    summary,
    score,
    points: points.length ? points : undefined,
    evidence: {
      md: reason,
      json: {
        rubricVersion: SPECIALIZED_RUBRIC_VERSION,
        overallSuccessRate: stats.overallSuccessRate,
        totalCalls: stats.totalCalls,
        successfulCalls: stats.successfulCalls,
        failedCalls: stats.failedCalls,
        perToolBreakdown: stats.perTool,
        errorPatterns: result.data.error_patterns,
        failureImpact: result.data.failure_impact,
      },
    },
  });
}
