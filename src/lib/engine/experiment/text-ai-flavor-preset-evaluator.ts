import type { EvaluatorOutput } from '../../evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { deductionScore, defineTextJudgeDefinition, runTextJudge, type TextDimension } from './text-judge-common';

export const TEXT_AI_FLAVOR_PRESET_ID = 'preset-text-ai-flavor';

const DEFINITION = defineTextJudgeDefinition({
  id: 'text-ai-flavor',
  title: '文本 AI 味检查评估器',
  dimensions: [
    { key: 'template_opening', label: '模板化开篇', description: '脱离具体语境的固定套话、泛化背景铺垫或重复开场句。' },
    { key: 'template_closing', label: '模板化结尾', description: '不增加信息的机械总结、祝福、邀约式固定收束句。' },
    { key: 'mechanical_transitions', label: '机械连接词堆砌', description: '连续堆叠序列、递进或宣告性连接词，使结构过度公式化。' },
    { key: 'generic_names', label: '泛化人物名称', description: '示例角色反复使用占位式默认姓名，缺乏语境、真实感和多样性。' },
    { key: 'empty_summary', label: '空洞总结与冗余收束', description: '不增加新信息、只重复前文或凑字数的总结段落。' },
    { key: 'politeness_overuse', label: '语气词与过度礼貌', description: '不合场景地堆叠语气词、礼貌用语、祝福或讨好式表达。' },
  ] satisfies readonly TextDimension[],
  rules: [
    '只评价 agent_output；user_question 仅用于理解文体与服务场景。',
    '模板句偶尔且符合语境时可判 minor；多个模板开头、连接词和结尾叠加时提高严重度。',
    '问题频率、覆盖范围和对读者的实际影响共同决定严重度，不因单个关键词自动扣分。',
  ],
  boundaryRules: [
    '客服场景的适度礼貌、技术文档、自然俗语引用和真实人物不属于 AI 味。',
    '短回复没有足够证据时判 safe，可在总体结论中说明文本过短。',
    '本评估器只评模板化风格，不评价观点新颖性或文采；后两者由创造性评估器负责。',
  ],
  buildInput: (ctx) => JSON.stringify({ user_question: ctx.caseInput, agent_output: ctx.actualOutput }, null, 2),
  aggregate: (verdicts) => deductionScore(verdicts),
});

export function runTextAiFlavorPreset(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  return runTextJudge(DEFINITION, user, ctx);
}
