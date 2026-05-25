/**
 * 预置评估器详情文案：与站内分类（Agent / 轨迹、任务完成、内容质量等）一致。
 * 「Agent 任务完成度」System Prompt 与变量、输出约定对齐常见评测预置规范。
 */

export type PresetDetailKind = 'llm' | 'code' | 'rpc';

export interface PresetEvaluatorDetail {
  kind: PresetDetailKind;
  /** 标签样式：如「描述：文本」 */
  mediaTags?: string[];
  applicationScenario: string;
  systemPrompt?: string;
  variables?: string[];
  outputScoreText: string;
  outputReasonText: string;
  /** Code / RPC 说明与示例 */
  implementationNote?: string;
  codeOrContractExample?: string;
}

const agentTaskCompletionPrompt = [
  '你是一位Agent任务评估助手，你的任务是评估一个 Agent 中是否成功、完整地实现了用户的目标。',
  '',
  '<输入>',
  '[用户输入]: {{user_input}}',
  '[Agent 响应]: {{agent_output}}',
  '</输入>',
  '',
  '<评分标准>',
  '请根据任务完成程度给出一个得分：',
  '- 1.0: 完全完成任务，表述清晰且完整。',
  '- 0.5: 基本完成任务，但内容不够清楚。',
  '- 0.0: Agent没有完成任务。即使解释合理，但实质上未完成用户任务也得 0 分。',
  '</评分标准>',
  '',
  '<思考指导>',
  '首先，请通过查看输入的上下文理解用户的真实意图。如果输入中没有明确表达意图，请尝试从上下文或消息内容中合理推断。一旦你理解了目标，请开始判断 Agent 最终策略是否成功完成了目标，然后依照评分标准，按照完成任务的程度给出最终得分。',
  '</思考指导>',
].join('\n');

const agentTraceQualityPrompt = [
  '你是 Agent 轨迹质量评测助手。请根据给定的执行轨迹，判断规划、工具调用与中间推理是否一致、稳健、可复现。',
  '',
  '<输入>',
  '[用户目标]: {{user_goal}}',
  '[轨迹 JSON / 步骤列表]: {{agent_trace}}',
  '[最终回答片段（可选）]: {{final_answer}}',
  '</输入>',
  '',
  '<评分标准>',
  '输出 0.0～1.0：',
  '- 1.0：轨迹与目标强一致；关键步骤无缺失；无明显循环/反复失败。',
  '- 0.5：大体完成但有冗余调用、次序不佳或次要信息缺失。',
  '- 0.0：关键步骤错误或轨迹与目标相悖。',
  '</评分标准>',
  '',
  '请先概括用户目标与轨迹主干，再按标准给分。',
].join('\n');

const outputScoreStd = [
  '最终的得分必须输出为一个数字，表示满足上述评分标准的程度。',
  '得分范围为 0.0～1.0：1.0 表示完全符合标准，0.0 表示完全不符合。',
].join('');

const outputReasonStd = [
  '对得分给出可读解释；结尾必须用一句话收束。',
  '收束句式：因此，应该给出的分数是你的评分。',
  '（将你的数值分数代入「你的评分」的语义——即明确写出具体分数）',
].join('');

/** id 与 EvaluatorsCenter.tsx 中 presetEvaluators[].id 一一对应 */
export const presetEvaluatorDetailById: Record<string, PresetEvaluatorDetail> = {
  'preset-agent-task-completion': {
    kind: 'llm',
    mediaTags: ['描述：文本', 'Agent通用评测', '任务完成'],
    applicationScenario: '评估一个 Agent 中是否成功、完整地实现了用户的目标。',
    systemPrompt: agentTaskCompletionPrompt,
    variables: ['user_input', 'agent_output'],
    outputScoreText: [
      outputScoreStd,
      '（本条与常见的「Agent 任务完成度」预置说明一致）',
    ].join(' '),
    outputReasonText: outputReasonStd,
  },
  'preset-agent-trace-quality': {
    kind: 'llm',
    mediaTags: ['描述：文本', '轨迹', 'Agent通用评测'],
    applicationScenario: '评估 Agent 执行轨迹的规划、推理与工具调用链路是否连贯、可信且与目标对齐。运行于 opencode 运行时，评估执行在链路分析中可见。',
    systemPrompt: agentTraceQualityPrompt,
    variables: ['user_goal', 'agent_trace', 'final_answer'],
    outputScoreText: outputScoreStd,
    outputReasonText: outputReasonStd,
  },
};

export function getPresetEvaluatorDetail(id: string): PresetEvaluatorDetail | undefined {
  return presetEvaluatorDetailById[id];
}
