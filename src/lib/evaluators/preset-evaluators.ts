import type { EvaluatorCard } from './custom-evaluator-model';

/**
 * 「用例分析」「批量测试」里默认勾选的评估器。
 *
 * **必须是显式列表，不要改回从 `status === 'ready'` 派生。** 派生的话，每新增一个预置
 * 评估器，「用户什么都没点就点评测」的默认行为就会多跑一个 LLM judge——而通用 judge
 * 每调一次会起一个临时 opencode server（`judge-llm.ts`），后台并发上限只有 5。
 * 参见 `eval-run-guards.ts` 记录的那次「并行跑多个评测任务 → next-server 堆 OOM」事故。
 *
 * 下拉框仍然列出全部 ready 的评估器，用户可以自行加勾——这里只管默认值。
 */
export const DEFAULT_SELECTED_PRESET_IDS: readonly string[] = [
  'preset-agent-task-completion',
  'preset-agent-trace-quality',
];

export const presetEvaluators: EvaluatorCard[] = [
  {
    id: 'preset-agent-task-completion',
    name: 'Agent 任务完成度',
    description: '评估 Agent 是否成功、完整地实现了用户目标，适合回归集和上线验收。',
    evaluatorType: 'LLM',
    source: 'preset',
    targetTypes: ['结果'],
    objectives: ['任务完成', '内容质量'],
    scenarios: ['Agent通用评测'],
    runMode: 'LLM Judge',
    scoreRange: '0-1',
    popularity: 96,
    mappedMetrics: ['目标达成', '步骤完整', '答案可用'],
    status: 'ready',
    runtimeHref: '/eval/trajectory',
    runtimeNote: 'opencode-task-completion-evaluator.ts (single opencode agent)',
  },
  {
    id: 'preset-agent-trace-quality',
    name: 'Agent 轨迹质量',
    description: '评估 Agent 内部执行轨迹是否准确、稳定，关注规划、调用和中间结果。基于 opencode 单主评估器完成 completeness / tool-choice / attribution 判断，并结合规则冗余检测。',
    evaluatorType: 'LLM',
    source: 'preset',
    targetTypes: ['轨迹'],
    objectives: ['轨迹质量'],
    scenarios: ['Agent通用评测', '轨迹评测'],
    runMode: 'Trace Judge (opencode)',
    scoreRange: '0-1',
    popularity: 91,
    mappedMetrics: ['轨迹准确性', '推理连续性', '异常处理'],
    status: 'ready',
    runtimeHref: '/eval/trajectory',
    runtimeNote: 'opencode-trajectory-evaluator.ts (single opencode agent)',
  },
  // ── 结果评测评估器（抽取自「可靠性与性能」的结果评测分析能力，与其共用同一 canonical 实现）──
  // 实现：result-preset-evaluators.ts（复用 result-quality-evaluator 的 runSingleResultMetric）
  {
    id: 'preset-result-accuracy',
    name: '结果准确性',
    description: '对照参考答案，逐关键观点判定 covered/partial/wrong/not_mentioned + 证据；与可靠性页同口径。',
    evaluatorType: 'LLM',
    source: 'preset',
    targetTypes: ['结果'],
    objectives: ['结果准确'],
    scenarios: ['有标准答案的结果验收'],
    runMode: 'LLM Judge (直连 · GT rubric)',
    scoreRange: '0-100',
    popularity: 90,
    mappedMetrics: ['关键观点覆盖'],
    status: 'ready',
    runtimeNote: 'result-preset-evaluators.ts · accuracy',
  },
  {
    id: 'preset-result-answer',
    name: '答案质量',
    description: '评估最终答案的相关性 / 完整性 / 连贯性三子维度；不依赖参考答案。',
    evaluatorType: 'LLM',
    source: 'preset',
    targetTypes: ['结果'],
    objectives: ['内容质量'],
    scenarios: ['开放式回答质量评估'],
    runMode: 'LLM Judge (直连 · self rubric)',
    scoreRange: '0-100',
    popularity: 84,
    mappedMetrics: ['相关性', '完整性', '连贯性'],
    status: 'ready',
    runtimeNote: 'result-preset-evaluators.ts · answer-quality',
  },
  {
    id: 'preset-result-faithfulness',
    name: '忠实度',
    description: '检测答案主张是否有执行轨迹证据支撑（幻觉检测）；证据=逐主张裁决与引用。',
    evaluatorType: 'LLM',
    source: 'preset',
    targetTypes: ['结果'],
    objectives: ['可信度'],
    scenarios: ['幻觉排查', '证据支撑核验'],
    runMode: 'LLM Judge (直连 · grounding)',
    scoreRange: '0-100',
    popularity: 82,
    mappedMetrics: ['主张支撑率'],
    status: 'ready',
    runtimeNote: 'result-preset-evaluators.ts · faithfulness',
  },
  {
    id: 'preset-result-instruction',
    name: '指令遵循',
    description: '抽取任务/系统指令约束并逐条判定是否遵守（met/not_met）；不依赖参考答案。',
    evaluatorType: 'LLM',
    source: 'preset',
    targetTypes: ['结果'],
    objectives: ['合规'],
    scenarios: ['约束遵循核验'],
    runMode: 'LLM Judge (直连 · self rubric)',
    scoreRange: '0-100',
    popularity: 80,
    mappedMetrics: ['约束满足率'],
    status: 'ready',
    runtimeNote: 'result-preset-evaluators.ts · instruction-adherence',
  },
];
