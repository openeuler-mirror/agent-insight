import type { EvaluatorOutput } from '../../evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { deductionScore, defineTextJudgeDefinition, runTextJudge, type TextDimension, type TextSeverity } from './text-judge-common';

export const TEXT_LANGUAGE_CONSISTENCY_PRESET_ID = 'preset-text-language-consistency';

export const TEXT_LANGUAGE_PENALTIES: Readonly<Record<string, Readonly<Record<TextSeverity, number>>>> = {
  primary_language_match: { safe: 0, minor: 20, moderate: 60, severe: 90 },
  unnecessary_mixing: { safe: 0, minor: 25, moderate: 55, severe: 75 },
  code_switch_rationale: { safe: 0, minor: 20, moderate: 45, severe: 65 },
  bilingual_handling: { safe: 0, minor: 25, moderate: 55, severe: 70 },
};

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
    '用户明确使用中英双语时，回复只覆盖一种语言的信息需求属于 bilingual_handling 问题。',
    '完全使用不同语言回答应将 primary_language_match 判 severe。',
  ],
  boundaryRules: [
    '标准技术术语与缩写、产品或人名、通用寒暄、翻译对照、外文原文引用和代码关键字均可合理混用。',
    '用户问题本身混合多种语言且是在逐词教学或翻译时，逐一解释属于合理处理。',
  ],
  buildInput: (ctx) => JSON.stringify({ user_question: ctx.caseInput, agent_output: ctx.actualOutput }, null, 2),
  aggregate: (verdicts) => deductionScore(verdicts, TEXT_LANGUAGE_PENALTIES),
  pointScore: (verdict) => 100 - TEXT_LANGUAGE_PENALTIES[verdict.dimension][verdict.severity],
  requiresCaseInput: true,
});

export function runTextLanguageConsistencyPreset(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  return runTextJudge(DEFINITION, user, ctx);
}
