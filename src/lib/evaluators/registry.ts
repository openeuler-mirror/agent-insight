/**
 * 评估器注册表：类目 / 前置条件 / 标签的单一事实来源。
 *
 * - 类目（category: res|traj）= 注册时元数据，决定结果在 Trace 评测详情的呈现板块
 *   与实验类目均分归属；运行时不可变更。预置评估器在此写死；自建评估器由创建表单
 *   填入 EvaluatorCard.category。归类准绳：只读最终输出（±参考答案）→ res；需要读
 *   执行过程（步骤/工具/耗时/成本/token）→ traj。
 * - 前置条件（requires）：实验 ④ 步按所选 case 的元数据门控——任一 case 不满足则
 *   该评估器整体不可选（硬门控，无"部分覆盖"）。自建 LLM 评估器的 requires 由
 *   提示词占位符自动推导（用到 {{reference_output}} → 'reference'）。tool_catalog 表示
 *   每个 case 必须显式提供 Tool/Skill 目录；availableTools=[] 仍算已提供，字段缺失才失败。
 * - 标签（tags）：UI 筛选与展示用，全部由元数据派生，不单独存储。
 *
 * 本文件只决定评估器归类、标签和可选性，不负责读取目录或执行评分。预置评估器产品信息位于
 * preset-evaluators.ts，实际运行由 src/lib/engine/experiment/run-experiment.ts 分发。
 */
import type { EvaluatorCard } from './custom-evaluator-model';

export type EvaluatorCategory = 'res' | 'traj';
/** 'reference' = 需要参考输出；'tool_catalog' = 需要显式 Tool/Skill 目录（空数组也算已提供）。 */
export type EvaluatorRequirement = 'reference' | 'tool_catalog';

export interface EvaluatorMeta {
  category: EvaluatorCategory;
  requires: EvaluatorRequirement[];
}

/** 预置评估器元数据（id 与 preset-evaluators.ts 一一对应）。 */
const PRESET_META: Record<string, EvaluatorMeta> = {
  'skill-trigger-analyzer': { category: 'res', requires: [] },
  // 任务完成度：对照参考答案判定目标达成（团队评审确定为依赖参考数据）
  'preset-agent-task-completion': { category: 'res', requires: ['reference'] },
  // 轨迹质量：只看执行过程，不依赖参考数据
  'preset-agent-trace-quality': { category: 'traj', requires: [] },
  // 结果评测评估器（抽取自可靠性页；看结果 → res）。仅准确性依赖参考数据。
  'preset-result-accuracy': { category: 'res', requires: ['reference'] },
  'preset-result-answer': { category: 'res', requires: [] },
  'preset-result-faithfulness': { category: 'res', requires: [] },
  'preset-result-instruction': { category: 'res', requires: [] },
  // 内容质量评估器：均不依赖参考数据
  'preset-content-insensitivity': { category: 'res', requires: [] },
  'preset-content-controversy': { category: 'res', requires: [] },
  'preset-content-gender-discrimination': { category: 'res', requires: [] },
  'preset-creativity-expression': { category: 'res', requires: [] },
  'preset-text-ai-flavor': { category: 'res', requires: [] },
  'preset-text-format': { category: 'res', requires: [] },
  'preset-text-language-consistency': { category: 'res', requires: [] },
  'preset-text-conciseness': { category: 'res', requires: [] },
  // 文本质量评估器（流畅度 / 幻觉检测）：只看最终输出，上下文可选不门控
  'preset-fluency-text': { category: 'res', requires: [] },
  'preset-hallucination-text': { category: 'res', requires: [] },
  'preset-safety-maliciousness': { category: 'res', requires: [] },
  'preset-safety-harmfulness': { category: 'res', requires: [] },
  'preset-safety-criminality': { category: 'res', requires: [] },
  'preset-safety-refusal': { category: 'res', requires: [] },
  'preset-depth-result': { category: 'res', requires: [] },
  'preset-agent-tool-utilization': { category: 'traj', requires: ['tool_catalog'] },
  'preset-agent-tool-selection': { category: 'traj', requires: ['tool_catalog'] },
  // 可靠性：挂 traj（本期不扩 EvaluatorCategory）；依赖 Trace/故障事件，不强制参考答案
  'preset-ras-reliability': { category: 'traj', requires: [] },
  'preset-ras-reliability-fault-injection': { category: 'traj', requires: [] },
  'preset-ras-reliability-detection-recovery': { category: 'traj', requires: [] },
};

const DEFAULT_META: EvaluatorMeta = { category: 'res', requires: [] };

/**
 * 已登记元数据的预置 id。
 *
 * getEvaluatorMeta 对未登记的预置 id 会静默回退 DEFAULT_META（category='res'、无门控），
 * 漏登记不会报错、只会让卡片归错类目并绕过 ④ 步门控——所以需要一个能从外部查证的出口，
 * 供 test/preset-registry-consistency.test.ts 断言"每张预置卡都登记了元数据"。
 */
export function hasPresetMeta(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PRESET_META, id);
}

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
  if (meta.requires.includes('tool_catalog')) tags.push('依赖 Tool/Skill 目录');
  return tags;
}

/** ④ 步门控输入：每条已圈选 case 的满足情况。 */
export interface CaseGateInfo {
  /** 该 case 是否已标注参考输出 */
  hasReference: boolean;
  /** 该 case 是否显式提供 Tool/Skill 目录；availableTools=[] 时为 true */
  hasToolCatalog: boolean;
}

export interface EvaluatorGateResult {
  usable: boolean;
  /** 不可用原因（给置灰 tooltip），usable=true 时为空 */
  reason?: string;
}

/** 硬门控：所选 case 有任一不满足 requires → 整体不可选。 */
export function gateEvaluator(meta: EvaluatorMeta, cases: CaseGateInfo[]): EvaluatorGateResult {
  if (meta.requires.length > 0 && cases.length === 0) {
    return { usable: false, reason: '尚未圈选 case——先在第 ② 步关联 Trace' };
  }
  if (meta.requires.includes('reference')) {
    const missing = cases.filter((c) => !c.hasReference).length;
    if (missing > 0) {
      return {
        usable: false,
        reason: `依赖参考数据：已选 ${cases.length} 个 case 中 ${missing} 个未标注参考答案——回第 ③ 步补齐标注后开放`,
      };
    }
  }
  if (meta.requires.includes('tool_catalog')) {
    const missing = cases.filter((c) => !c.hasToolCatalog).length;
    if (missing > 0) {
      return {
        usable: false,
        reason: `依赖 Tool/Skill 目录：已选 ${cases.length} 个 case 中 ${missing} 个未提供 available_tools——回第 ③ 步从数据集导入后开放`,
      };
    }
  }
  return { usable: true };
}
