/**
 * 实验 ③ 步「预期答案」与评测数据集的双向转换：
 * - expectedOutput ↔ case.referenceOutput，供依赖参考答案的评估器使用；
 * - values.available_tools / available_skills ↔ case.evaluatorContext，供 Tool/Skill
 *   利用率与选择合理性评估器取得“本次任务可用的能力目录”。available_tools 是上下文
 *   的入口字段且允许显式空数组，available_skills 可选；Agent/子 Agent 不在该目录中。
 *
 * 两类数据独立匹配、独立判断是否覆盖已有值，也可以只有其中一类。Trace 输入包含数据集
 * 输入即命中；多条数据集输入同时命中时优先取更长、更具体的一条。默认保护已有标注；
 * 调用方只有显式传 overwrite 才会覆盖。
 */
import {
  contextFromAvailableCatalogFields,
  type EvaluatorCaseContext,
} from '@/lib/evaluators/evaluator-case-context';

export interface MatchableCase {
  /** case 标识（ExperimentCase.id 或向导内的临时 key） */
  key: string;
  input: string;
  /** 现有参考输出；非空视为"已标注" */
  referenceOutput?: string | null;
  /** 现有评估器上下文；null/undefined=未提供，空 Tool/Skill 目录仍是有效上下文。 */
  evaluatorContext?: EvaluatorCaseContext | null;
}

export interface DatasetCaseLike {
  input: string;
  expectedOutput?: string;
  values?: Record<string, unknown>;
}

export interface DatasetMatchResult {
  /** key → 待回填的参考输出（仅命中且允许写入的条目） */
  updates: Record<string, string>;
  /** key → 按 available_tools / available_skills 回填的 v1 上下文。 */
  contextUpdates: Record<string, EvaluatorCaseContext>;
  /** 命中并回填的条数 */
  matched: number;
  /** 命中但因已标注而跳过的条数 */
  skipped: number;
  /** 未在数据集中找到对应输入的条数 */
  unmatched: number;
  contextMatched: number;
  contextSkipped: number;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().replace(/\s+/g, ' ');

/** Trace 输入包含数据集输入即命中；多条命中时取最长输入，同长度保持数据集原顺序。 */
export function findBestDatasetInputMatch<T extends { input?: string | null }>(
  traceInput: string | null | undefined,
  datasetCases: readonly T[],
): T | undefined {
  const normalizedTraceInput = norm(traceInput);
  if (!normalizedTraceInput) return undefined;

  let best: T | undefined;
  let bestLength = -1;
  for (const datasetCase of datasetCases) {
    const datasetInput = norm(datasetCase.input);
    if (!datasetInput || !normalizedTraceInput.includes(datasetInput)) continue;
    if (datasetInput.length > bestLength) {
      best = datasetCase;
      bestLength = datasetInput.length;
    }
  }
  return best;
}

/**
 * Trace 输入包含数据集输入时回填参考输出。
 * @param overwrite 为 true 时覆盖已标注的 case（默认 false=跳过）
 */
export function matchDatasetCases(
  cases: MatchableCase[],
  datasetCases: DatasetCaseLike[],
  overwrite = false,
): DatasetMatchResult {
  // 参考答案和能力目录独立取同输入下各自首个有效定义，避免一类数据遮蔽另一类。
  const referenceByInput = new Map<string, string>();
  const contextByInput = new Map<string, {
    availableTools: unknown;
    availableSkills: unknown;
    hasSkills: boolean;
  }>();
  for (const dc of datasetCases) {
    const key = norm(dc.input);
    if (!key) continue;
    const expected = norm(dc.expectedOutput);
    if (expected && !referenceByInput.has(key)) referenceByInput.set(key, expected);
    if (
      dc.values
      && Object.prototype.hasOwnProperty.call(dc.values, 'available_tools')
      && !contextByInput.has(key)
    ) {
      contextByInput.set(key, {
        availableTools: dc.values.available_tools,
        availableSkills: dc.values.available_skills,
        hasSkills: Object.prototype.hasOwnProperty.call(dc.values, 'available_skills'),
      });
    }
  }

  const result: DatasetMatchResult = {
    updates: {}, contextUpdates: {}, matched: 0, skipped: 0, unmatched: 0,
    contextMatched: 0, contextSkipped: 0,
  };
  const referenceInputs = Array.from(referenceByInput.keys()).map(input => ({ input }));
  const contextInputs = Array.from(contextByInput.keys()).map(input => ({ input }));
  for (const c of cases) {
    const inputKey = norm(c.input);
    const matchedReference = findBestDatasetInputMatch(inputKey, referenceInputs);
    const matchedContext = findBestDatasetInputMatch(inputKey, contextInputs);
    const expected = matchedReference ? referenceByInput.get(matchedReference.input) : undefined;
    const catalogFields = matchedContext ? contextByInput.get(matchedContext.input) : undefined;
    if (expected === undefined && catalogFields === undefined) {
      result.unmatched++;
      continue;
    }
    let supplied = false;
    if (expected) {
      supplied = true;
      if (norm(c.referenceOutput) && !overwrite) {
        result.skipped++;
      } else {
        result.updates[c.key] = expected;
        result.matched++;
      }
    }
    if (catalogFields) {
      const context = contextFromAvailableCatalogFields(
        catalogFields.availableTools,
        catalogFields.hasSkills ? catalogFields.availableSkills : undefined,
      );
      if (context) {
        supplied = true;
        if (c.evaluatorContext && !overwrite) {
          result.contextSkipped++;
        } else {
          result.contextUpdates[c.key] = context;
          result.contextMatched++;
        }
      }
    }
    if (!supplied) result.unmatched++;
  }
  return result;
}

/** 导入结果的人话摘要（UI toast 用）。 */
export function describeMatchResult(r: DatasetMatchResult): string {
  const parts = [`已回填 ${r.matched} 条`];
  if (r.contextMatched) parts.push(`导入 ${r.contextMatched} 条 Tool/Skill 目录`);
  if (r.skipped) parts.push(`跳过 ${r.skipped} 条已标注`);
  if (r.contextSkipped) parts.push(`跳过 ${r.contextSkipped} 条已有工具目录`);
  if (r.unmatched) parts.push(`${r.unmatched} 条未匹配`);
  return parts.join(' · ');
}

/** 已标注的 case → 数据集 cases（未标注的不导出）。 */
export function toDatasetCases(
  cases: Array<{
    input: string;
    referenceOutput?: string | null;
    evaluatorContext?: EvaluatorCaseContext | null;
  }>,
): Array<{ input: string; expectedOutput: string; values?: Record<string, unknown> }> {
  return cases
    .filter((c) => norm(c.input) && (norm(c.referenceOutput) || c.evaluatorContext))
    .map((c) => ({
      input: norm(c.input),
      expectedOutput: norm(c.referenceOutput),
      ...(c.evaluatorContext ? {
        values: {
          available_tools: c.evaluatorContext.availableTools,
          ...(c.evaluatorContext.availableSkills !== undefined
            ? { available_skills: c.evaluatorContext.availableSkills }
            : {}),
        },
      } : {}),
    }));
}
