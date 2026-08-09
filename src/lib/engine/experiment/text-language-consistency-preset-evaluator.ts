import type { EvaluatorOutput } from '../../evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import {
  configuredDeductionScore,
  defineTextJudgeDefinition,
  defineTextRiskAggregateConfig,
  runTextJudge,
  type TextDimension,
} from './text-judge-common';

export const TEXT_LANGUAGE_CONSISTENCY_PRESET_ID = 'preset-text-language-consistency';

export const TEXT_LANGUAGE_RISK_CONFIG = defineTextRiskAggregateConfig({
  dimensionKeys: [
    'primary_language_match',
    'unnecessary_mixing',
    'code_switch_rationale',
    'bilingual_handling',
  ],
  criticalDimensionKeys: ['primary_language_match'],
  ordinaryDimensionKeys: ['unnecessary_mixing', 'code_switch_rationale', 'bilingual_handling'],
});

const DEFINITION = defineTextJudgeDefinition({
  id: 'text-language-consistency',
  title: '文本语种一致性评估器',
  dimensions: [
    { key: 'primary_language_match', label: '主语言一致性', description: '回复主语言是否匹配用户问题主语言；完全错语种属于 severe。' },
    { key: 'unnecessary_mixing', label: '非必要语言混杂', description: '排除标准技术术语、专有名称、通用寒暄、引用和翻译对照后，识别不必要的完整外语句或词组。' },
    { key: 'code_switch_rationale', label: '代码切换合理性', description: '语言切换是否有翻译、术语解释、原文引用或技术标准等合理理由。' },
    { key: 'bilingual_handling', label: '双语场景处理', description: '用户混合语言提问时，回复是否覆盖两种语言的信息需求；逐词教学翻译属于合理处理。' },
  ] satisfies readonly TextDimension[],
  rules: [
    '先识别用户和回复的主语言，再判断切换是否必要；不要按字符数量机械判定。',
    '先逐一识别回复中的外语片段并应用豁免；如果外语内容全部属于豁免，unnecessary_mixing 与 code_switch_rationale 必须判 safe。',
    '在单一主语言正文中，出现三个及以上具有成熟本地译名的普通外语词或词组作为句子成分时，必须判 unnecessary_mixing 为 severe；技术主题或这些词在技术讨论中常见，都不构成豁免。',
    '仅正式缩写、协议或 API 的固定名称、代码标识符、品牌名称及没有通行本地译名的行业术语属于技术豁免；普通外语词不能因含义与技术有关就视为标准技术标识。',
    '用户明确使用中英双语时，回复只覆盖一种语言的信息需求属于 bilingual_handling 问题。',
    '完全使用不同语言回答应将 primary_language_match 判 severe。',
  ],
  boundaryRules: [
    '标准技术术语与缩写、产品或人名、通用寒暄、翻译对照、外文原文引用和代码关键字均为强制豁免；简短外语寒暄与主语言寒暄并用也不得扣分。',
    '用户问题本身混合多种语言且是在逐词教学或翻译时，逐一解释属于合理处理。',
  ],
  buildInput: (ctx) => JSON.stringify({ user_question: ctx.caseInput, agent_output: ctx.actualOutput }, null, 2),
  aggregate: (verdicts) => configuredDeductionScore(verdicts, TEXT_LANGUAGE_RISK_CONFIG),
  requiresCaseInput: true,
});

export function runTextLanguageConsistencyPreset(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  return runTextJudge(DEFINITION, user, ctx);
}
