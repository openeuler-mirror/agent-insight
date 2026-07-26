/**
 * 实验详情聚合口径（纯函数，前端渲染与测试共用）。
 *
 * 口径统一：「有分」= status==='done' 且 score 为数值；无分（含评估失败/待执行）
 * 不进分母（与 eval-output.ts 的 averageScore 一致）。均分保留 1 位小数。
 * 类目（res/traj）由调用方传入 categoryOf（evaluatorId → 类目，来自 registry 元数据）。
 */
import { averageScore } from '@/lib/evaluators/eval-output';
import type { EvaluatorCategory } from '@/lib/evaluators/registry';

export interface ResultRowLike {
  caseId: string;
  evaluatorId: string;
  status: string;
  score: number | null;
}

export type CategoryOf = (evaluatorId: string) => EvaluatorCategory;

/** 有分行：done 且 score 为数值。 */
export function scoredRows<T extends ResultRowLike>(rows: T[]): T[] {
  return rows.filter((r) => r.status === 'done' && typeof r.score === 'number');
}

/** 综合均分：所有有分行均分；无有分行 → null。 */
export function overallAverage(rows: ResultRowLike[]): number | null {
  return averageScore(scoredRows(rows));
}

export interface EvaluatorBreakdownRow {
  evaluatorId: string;
  /** 该评估器有分行均分；无有分行 → null */
  avg: number | null;
  /** N：有分行数 */
  scored: number;
  /** M：该评估器结果行总数 */
  total: number;
  failed: number;
}

/** 评估器分解：按 evaluatorId 归组（保持首次出现顺序）。 */
export function evaluatorBreakdown(rows: ResultRowLike[]): EvaluatorBreakdownRow[] {
  const order: string[] = [];
  const grouped = new Map<string, ResultRowLike[]>();
  for (const r of rows) {
    if (!grouped.has(r.evaluatorId)) {
      grouped.set(r.evaluatorId, []);
      order.push(r.evaluatorId);
    }
    grouped.get(r.evaluatorId)!.push(r);
  }
  return order.map((evaluatorId) => {
    const list = grouped.get(evaluatorId)!;
    const scored = scoredRows(list);
    return {
      evaluatorId,
      avg: averageScore(scored),
      scored: scored.length,
      total: list.length,
      failed: list.filter((r) => r.status === 'failed').length,
    };
  });
}

export interface CaseScore {
  /** 该 case 所有有分行均分 */
  overall: number | null;
  /** 结果类评估器有分行均分 */
  res: number | null;
  /** 轨迹类评估器有分行均分 */
  traj: number | null;
  failed: number;
}

/** 单 case 综合/结果/轨迹得分（rows 需已按 caseId 过滤）。 */
export function caseScore(rows: ResultRowLike[], categoryOf: CategoryOf): CaseScore {
  const scored = scoredRows(rows);
  return {
    overall: averageScore(scored),
    res: averageScore(scored.filter((r) => categoryOf(r.evaluatorId) === 'res')),
    traj: averageScore(scored.filter((r) => categoryOf(r.evaluatorId) === 'traj')),
    failed: rows.filter((r) => r.status === 'failed').length,
  };
}

/** 按类目归组（结果行级；类目下无行则为空数组）。 */
export function groupByCategory<T extends ResultRowLike>(
  rows: T[],
  categoryOf: CategoryOf,
): Record<EvaluatorCategory, T[]> {
  const out: Record<EvaluatorCategory, T[]> = { res: [], traj: [] };
  for (const r of rows) out[categoryOf(r.evaluatorId)].push(r);
  return out;
}

export interface CategorySummary {
  /** 类目均分（有分行）；无有分行 → null */
  avg: number | null;
  /** N：有分行数 */
  scored: number;
  /** M：该类目结果行总数 */
  total: number;
}

/** 类目均分 + 「N/M 项计入」标注（rows 需已按类目过滤）。 */
export function categorySummary(rows: ResultRowLike[]): CategorySummary {
  const scored = scoredRows(rows);
  return { avg: averageScore(scored), scored: scored.length, total: rows.length };
}
