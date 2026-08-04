/**
 * 实验详情聚合口径（纯函数，前端渲染与测试共用）。
 *
 * 口径统一：「有分」= status==='done' 且**生效分**为数值；无分（含评估失败/待执行）
 * 不进分母（与 eval-output.ts 的 averageScore 一致）。均分保留 1 位小数。
 * 类目（res/traj）由调用方传入 categoryOf（evaluatorId → 类目，来自 registry 元数据）。
 *
 * **生效分 = humanScore ?? score**：人工修正过的行按人工分参与全部统计（综合均分、
 * 评估器分解、类目均分、单 case 得分），机器分原样留在 score 里只读——两者的差值是
 * 校准评估器的依据。所有聚合都必须走 effectiveScore，不要直接读 .score。
 */
import { averageScore } from '@/lib/evaluators/eval-output';
import type { EvaluatorCategory } from '@/lib/evaluators/registry';

export interface ResultRowLike {
  caseId: string;
  evaluatorId: string;
  status: string;
  score: number | null;
  /** 人工修正分；未修正为 null/undefined（老调用方可不传） */
  humanScore?: number | null;
}

export type CategoryOf = (evaluatorId: string) => EvaluatorCategory;

/** 生效分：人工修正分优先，回落机器分；都没有 → null。 */
export function effectiveScore(row: ResultRowLike): number | null {
  if (typeof row.humanScore === 'number') return row.humanScore;
  return typeof row.score === 'number' ? row.score : null;
}

/** 该行是否被人工修正过（呈现层打标记用）。 */
export function isHumanAdjusted(row: ResultRowLike): boolean {
  return typeof row.humanScore === 'number';
}

/** 有分行：done 且生效分为数值。 */
export function scoredRows<T extends ResultRowLike>(rows: T[]): T[] {
  return rows.filter((r) => r.status === 'done' && effectiveScore(r) !== null);
}

/** 有分行 → 喂给 averageScore 的形状（统一折算成生效分）。 */
function toScored(rows: ResultRowLike[]): Array<{ score: number }> {
  return scoredRows(rows).map((r) => ({ score: effectiveScore(r) as number }));
}

/** 综合均分：所有有分行均分；无有分行 → null。 */
export function overallAverage(rows: ResultRowLike[]): number | null {
  return averageScore(toScored(rows));
}

export interface EvaluatorBreakdownRow {
  evaluatorId: string;
  /** 该评估器有分行均分（按生效分）；无有分行 → null */
  avg: number | null;
  /** N：有分行数 */
  scored: number;
  /** M：该评估器结果行总数 */
  total: number;
  failed: number;
  /** 其中被人工修正过的行数（呈现层提示"均分含人工修正"） */
  adjusted: number;
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
      avg: averageScore(toScored(list)),
      scored: scored.length,
      total: list.length,
      failed: list.filter((r) => r.status === 'failed').length,
      adjusted: scored.filter(isHumanAdjusted).length,
    };
  });
}

export interface CaseScore {
  /** 该 case 所有有分行均分（按生效分） */
  overall: number | null;
  /** 结果类评估器有分行均分 */
  res: number | null;
  /** 轨迹类评估器有分行均分 */
  traj: number | null;
  failed: number;
  /** 该 case 下被人工修正过的结果行数 */
  adjusted: number;
}

/** 单 case 综合/结果/轨迹得分（rows 需已按 caseId 过滤）。 */
export function caseScore(rows: ResultRowLike[], categoryOf: CategoryOf): CaseScore {
  const scored = scoredRows(rows);
  return {
    overall: averageScore(toScored(rows)),
    res: averageScore(toScored(rows.filter((r) => categoryOf(r.evaluatorId) === 'res'))),
    traj: averageScore(toScored(rows.filter((r) => categoryOf(r.evaluatorId) === 'traj'))),
    failed: rows.filter((r) => r.status === 'failed').length,
    adjusted: scored.filter(isHumanAdjusted).length,
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
  /** 类目均分（有分行，按生效分）；无有分行 → null */
  avg: number | null;
  /** N：有分行数 */
  scored: number;
  /** M：该类目结果行总数 */
  total: number;
  /** 其中被人工修正过的行数 */
  adjusted: number;
}

/** 类目均分 + 「N/M 项计入」标注（rows 需已按类目过滤）。 */
export function categorySummary(rows: ResultRowLike[]): CategorySummary {
  const scored = scoredRows(rows);
  return {
    avg: averageScore(toScored(rows)),
    scored: scored.length,
    total: rows.length,
    adjusted: scored.filter(isHumanAdjusted).length,
  };
}
