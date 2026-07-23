/**
 * 评估器注册表：类目 / 前置条件 / 标签的单一事实来源。
 *
 * - 类目（category: res|traj）= 注册时元数据，决定结果在 Trace 评测详情的呈现板块
 *   与实验类目均分归属；运行时不可变更。预置评估器在此写死；自建评估器由创建表单
 *   填入 EvaluatorCard.category。归类准绳：只读最终输出（±参考答案）→ res；需要读
 *   执行过程（步骤/工具/耗时/成本/token）→ traj。
 * - 前置条件（requires）：实验 ④ 步按所选 case 的元数据门控——任一 case 不满足则
 *   该评估器整体不可选（硬门控，无"部分覆盖"）。自建 LLM 评估器的 requires 由
 *   提示词占位符自动推导（用到 {{reference_output}} → 'reference'）。
 * - 标签（tags）：UI 筛选与展示用，全部由元数据派生，不单独存储。
 */
import type { EvaluatorCard } from './custom-evaluator-model';

export type EvaluatorCategory = 'res' | 'traj';
/** 'reference' = 需要该 case 已标注参考输出（预期答案） */
export type EvaluatorRequirement = 'reference';

export interface EvaluatorMeta {
  category: EvaluatorCategory;
  requires: EvaluatorRequirement[];
}

/** 预置评估器元数据（id 与 preset-evaluators.ts 一一对应）。
 *  M2 新增的代码类预置评估器在此登记 category/requires。 */
const PRESET_META: Record<string, EvaluatorMeta> = {
  // 任务完成度：对照参考答案判定目标达成（团队评审确定为依赖参考数据）
  'preset-agent-task-completion': { category: 'res', requires: ['reference'] },
  // 轨迹质量：只看执行过程，不依赖参考数据
  'preset-agent-trace-quality': { category: 'traj', requires: [] },
  // 预置代码评估器（独立能力单元，零配置、不依赖参考数据，全部读执行过程 → traj）
  'preset-code-tool-reliability': { category: 'traj', requires: [] },
  'preset-code-latency-budget': { category: 'traj', requires: [] },
  'preset-code-cost-budget': { category: 'traj', requires: [] },
  'preset-code-redundancy-loop': { category: 'traj', requires: [] },
  'preset-code-token-efficiency': { category: 'traj', requires: [] },
  // 结果评测评估器（抽取自可靠性页；看结果 → res）。仅准确性依赖参考数据。
  'preset-result-accuracy': { category: 'res', requires: ['reference'] },
  'preset-result-answer': { category: 'res', requires: [] },
  'preset-result-faithfulness': { category: 'res', requires: [] },
  'preset-result-instruction': { category: 'res', requires: [] },
};

const DEFAULT_META: EvaluatorMeta = { category: 'res', requires: [] };

/** 自建 LLM 评估器：requires 由提示词占位符推导。 */
function deriveCustomRequires(card: EvaluatorCard): EvaluatorRequirement[] {
  const text = `${card.llmConfig?.systemPrompt ?? ''}\n${card.llmConfig?.userPrompt ?? ''}`;
  return /\{\{\s*reference_output\s*\}\}/.test(text) ? ['reference'] : [];
}

export function getEvaluatorMeta(card: EvaluatorCard): EvaluatorMeta {
  if (card.source === 'preset') {
    return PRESET_META[card.id] ?? { ...DEFAULT_META, category: card.category ?? 'res' };
  }
  return { category: card.category ?? 'res', requires: deriveCustomRequires(card) };
}

/** UI 标签（筛选与卡片展示统一从这里派生，勿在组件里各写一份）。 */
export function deriveEvaluatorTags(card: EvaluatorCard): string[] {
  const meta = getEvaluatorMeta(card);
  const tags: string[] = [];
  tags.push(card.source === 'preset' ? '预置' : '自建');
  tags.push(card.evaluatorType === 'LLM' ? 'LLM Judge' : '代码');
  tags.push(meta.category === 'res' ? '看结果' : '看轨迹');
  if (meta.requires.includes('reference')) tags.push('依赖参考数据');
  return tags;
}

/** ④ 步门控输入：每条已圈选 case 的满足情况。 */
export interface CaseGateInfo {
  /** 该 case 是否已标注参考输出 */
  hasReference: boolean;
}

export interface EvaluatorGateResult {
  usable: boolean;
  /** 不可用原因（给置灰 tooltip），usable=true 时为空 */
  reason?: string;
}

/** 硬门控：所选 case 有任一不满足 requires → 整体不可选。 */
export function gateEvaluator(meta: EvaluatorMeta, cases: CaseGateInfo[]): EvaluatorGateResult {
  if (meta.requires.includes('reference')) {
    const missing = cases.filter((c) => !c.hasReference).length;
    if (cases.length === 0) {
      return { usable: false, reason: '尚未圈选 case——先在第 ② 步关联 Trace' };
    }
    if (missing > 0) {
      return {
        usable: false,
        reason: `依赖参考数据：已选 ${cases.length} 个 case 中 ${missing} 个未标注参考答案——回第 ③ 步补齐标注后开放`,
      };
    }
  }
  return { usable: true };
}
