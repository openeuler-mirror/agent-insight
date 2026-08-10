/**
 * A/B 灰度评测「选了哪些评估器」的纯逻辑（无重依赖，可单测）。
 *
 * 拆出来的原因同 eval-run-guards.ts：灰度 route.ts 拉了一大堆 server-only 依赖，
 * 测试里 import 不进来；而这几条规则直接关系到一个真实故障——
 * 用户在灰度页勾了结果类预置评估器，被后端按 2 个 legacy id 的白名单**静默滤空**，
 * backing 实验建成 0 个评估器、评测 0 行，最终只在 UI 上留一句「评测失败」，无任何原因。
 */
import { presetEvaluators } from '@/lib/evaluators/preset-evaluators';

export const TASK_COMPLETION_EVALUATOR_ID = 'preset-agent-task-completion';
export const TRACE_EVALUATOR_ID = 'preset-agent-trace-quality';

/** 历史别名：早期灰度配置里存的是这个名字。 */
const LEGACY_TRACE_ALIAS = 'trace-quality-evaluator';

/**
 * 旧 TrajectoryEvalResult 行**投影**能表达的评估器。
 *
 * 那张表只有 trajectoryScore 一列 + rawAnalysisJson 里的 resultScore，
 * 投影时把前者硬映射成轨迹质量、后者硬映射成任务完成度——别的评估器在这条路径上
 * 没有可读的落点，塞进来只会被错读成轨迹分。
 *
 * **这不是能力白名单。** A/B 评测早已改走 backing 实验（evaluateSingleRunTarget →
 * evaluateEvalExperimentCase），那条路支持全部已注册评估器，不受此限制。
 */
export const LEGACY_ROW_EVALUATORS: ReadonlySet<string> = new Set([
  TASK_COMPLETION_EVALUATOR_ID,
  TRACE_EVALUATOR_ID,
]);

/**
 * 归一化 A/B 评测选中的评估器 id：去空白、老别名归一、去重；列表为空时退到 fallback。
 *
 * **不做能力白名单过滤**——未知 id 交给下游实验引擎抛「未找到评估器 X」，
 * 那是用户能看懂的失败；静默丢弃不是。
 */
export function normalizeAbEvaluators(value: unknown, fallback?: string): string[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const ids = Array.from(new Set(
    raw.map(item => String(item || '').trim())
      .map(item => (item === LEGACY_TRACE_ALIAS ? TRACE_EVALUATOR_ID : item))
      .filter(Boolean),
  ));
  if (ids.length > 0) return ids;
  const fallbackId = fallback === LEGACY_TRACE_ALIAS ? TRACE_EVALUATOR_ID : String(fallback || '').trim();
  return fallbackId ? [fallbackId] : [];
}

/** 只保留 legacy 行投影能表达的评估器（供 buildRunEvaluationsFromRow 用）。 */
export function forLegacyRowProjection(ids: string[]): string[] {
  return ids.filter(id => LEGACY_ROW_EVALUATORS.has(id));
}

/** 评估器展示名：从注册表派生，别再手工维护一份（新增预置会自动跟上）。 */
export function abEvaluatorName(id: string): string {
  return presetEvaluators.find(card => card.id === id)?.name || id;
}
