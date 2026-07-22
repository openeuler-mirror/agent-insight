/**
 * 实验 ③ 步「预期答案」与评测数据集的互通：
 * - 从数据集导入：按任务输入把数据集里的 expectedOutput 回填为 case 的参考输出
 * - 存为数据集：把已标注的 case 导出为数据集 cases（数据集是实验副产品，非前置门槛）
 *
 * 匹配口径（刻意保守）：**输入文本 trim 后全等**才算命中，不做模糊/相似度匹配——
 * 模糊匹配会把不对应的参考答案塞进来，污染的是评测结论本身，代价远大于少匹配几条。
 * 已手工标注的 case 默认跳过（保护人工成果），由调用方传 overwrite 显式覆盖。
 */

export interface MatchableCase {
  /** case 标识（ExperimentCase.id 或向导内的临时 key） */
  key: string;
  input: string;
  /** 现有参考输出；非空视为"已标注" */
  referenceOutput?: string | null;
}

export interface DatasetCaseLike {
  input: string;
  expectedOutput: string;
}

export interface DatasetMatchResult {
  /** key → 待回填的参考输出（仅命中且允许写入的条目） */
  updates: Record<string, string>;
  /** 命中并回填的条数 */
  matched: number;
  /** 命中但因已标注而跳过的条数 */
  skipped: number;
  /** 未在数据集中找到对应输入的条数 */
  unmatched: number;
}

const norm = (s: string | null | undefined) => (s ?? '').trim();

/**
 * 按输入精确匹配回填参考输出。
 * @param overwrite 为 true 时覆盖已标注的 case（默认 false=跳过）
 */
export function matchDatasetCases(
  cases: MatchableCase[],
  datasetCases: DatasetCaseLike[],
  overwrite = false,
): DatasetMatchResult {
  // 数据集侧同输入多条时以首条为准（后续条目视为重复定义，忽略）
  const byInput = new Map<string, string>();
  for (const dc of datasetCases) {
    const key = norm(dc.input);
    const expected = norm(dc.expectedOutput);
    if (!key || !expected || byInput.has(key)) continue;
    byInput.set(key, expected);
  }

  const result: DatasetMatchResult = { updates: {}, matched: 0, skipped: 0, unmatched: 0 };
  for (const c of cases) {
    const hit = byInput.get(norm(c.input));
    if (hit === undefined) {
      result.unmatched++;
      continue;
    }
    if (norm(c.referenceOutput) && !overwrite) {
      result.skipped++;
      continue;
    }
    result.updates[c.key] = hit;
    result.matched++;
  }
  return result;
}

/** 导入结果的人话摘要（UI toast 用）。 */
export function describeMatchResult(r: DatasetMatchResult): string {
  const parts = [`已回填 ${r.matched} 条`];
  if (r.skipped) parts.push(`跳过 ${r.skipped} 条已标注`);
  if (r.unmatched) parts.push(`${r.unmatched} 条未匹配`);
  return parts.join(' · ');
}

/** 已标注的 case → 数据集 cases（未标注的不导出）。 */
export function toDatasetCases(
  cases: Array<{ input: string; referenceOutput?: string | null }>,
): Array<{ input: string; expectedOutput: string }> {
  return cases
    .filter((c) => norm(c.input) && norm(c.referenceOutput))
    .map((c) => ({ input: norm(c.input), expectedOutput: norm(c.referenceOutput) }));
}
