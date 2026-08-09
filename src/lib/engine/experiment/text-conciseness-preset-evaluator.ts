import type { EvaluatorOutput } from '../../evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import { defineTextJudgeDefinition, runTextJudge, type TextDimension, type TextSeverity, type TextVerdict } from './text-judge-common';

export const TEXT_CONCISENESS_PRESET_ID = 'preset-text-conciseness';

const POINT_SCORES: Readonly<Record<TextSeverity, number>> = { safe: 100, minor: 70, moderate: 40, severe: 0 };

export function aggregateTextConcisenessScore(verdicts: readonly TextVerdict[]): number {
  const weights: Record<string, number> = {
    expression_efficiency: 0.3,
    cliche_condensation: 0.2,
    main_focus: 0.3,
    information_completeness: 0.2,
  };
  const byKey = new Map(verdicts.map((verdict) => [verdict.dimension, verdict]));
  let score = verdicts.reduce((sum, verdict) => sum + POINT_SCORES[verdict.severity] * weights[verdict.dimension], 0);
  const capSevere = (key: string, ceiling: number) => { if (byKey.get(key)?.severity === 'severe') score = Math.min(score, ceiling); };
  capSevere('expression_efficiency', 30);
  capSevere('cliche_condensation', 40);
  capSevere('main_focus', 40);
  if (byKey.get('information_completeness')?.severity === 'severe') score = Math.min(score, 50);
  if (byKey.get('information_completeness')?.severity === 'moderate') score = Math.min(score, 60);
  if (byKey.get('expression_efficiency')?.severity === 'moderate') score = Math.min(score, 70);
  return Math.max(0, Math.min(100, Math.round(score)));
}

const DEFINITION = defineTextJudgeDefinition({
  id: 'text-conciseness',
  title: '文本简洁性评估器',
  dimensions: [
    { key: 'expression_efficiency', label: '表达效率', description: '同义修饰、填充词、重复并列和可用更少文字表达的内容。' },
    { key: 'cliche_condensation', label: '套话精简度', description: '无关开场白、致谢祝福、免责声明和反复自我表态。' },
    { key: 'main_focus', label: '主需求聚焦度', description: '是否先回答核心问题，是否加入超出需求的背景、历史或扩展。' },
    { key: 'information_completeness', label: '信息完整性', description: '精简后是否保留完成任务所需的关键步骤、条件、限制和解释。' },
  ] satisfies readonly TextDimension[],
  rules: [
    '表达效率和主需求聚焦各占 0.3，套话精简和信息完整各占 0.2。',
    '信息完整性是兜底维度：删掉必要条件、关键步骤或限制时，即使文字短也不得高分。',
    '严重表达冗余、套话、偏题扩写或信息缺失会触发总分上限。',
    '以下档位是硬锚点，满足条件时必须采用指定等级，不得因回复总体可读、语气自然或已经识别到部分问题而降档。',
    '当简单事实问题已在一个短句中完整作答，而其余内容只重复、修饰或主观评价该答案时，必须判 expression_efficiency 为 severe；信息均必要但存在成段可压缩表达时判 moderate；仅局部措辞拖沓时判 minor。',
    '完整操作过程若被写成一串叙述性完整句、但可在不丢失任何步骤的前提下整体压缩成简短操作路径，必须判 expression_efficiency 为 moderate，而不是 minor。',
    '简单问题的直接答案出现在两句及以上不影响结论的背景之后，或未请求的扩展内容主导回复时，必须判 main_focus 为 severe，而不是 moderate。',
    '操作型回答只有泛化动作，并在必要来源或版本、前置条件、关键选项、结果验证中缺少两类及以上信息，使用户无法可靠完成任务时，必须判 information_completeness 为 severe，而不是 moderate。',
    '如果理由或总结已经指出两类及以上必要信息缺失，information_completeness 不得仍判 moderate；如果已经指出直接答案位于两句及以上无关背景之后，main_focus 不得仍判 moderate。',
    '同一问题优先归入最直接的维度；不得仅因缺少可选替代方案、额外确认提示或非必要补充信息而扣 information_completeness。',
  ],
  boundaryRules: [
    '概念解释、客服投诉和安全提醒需要的必要长度不算冗余。',
    '简单事实问答可以只有一句话；背景信息若有必要，应在核心答案之后并保持紧凑。',
  ],
  buildInput: (ctx) => JSON.stringify({ user_question: ctx.caseInput, agent_output: ctx.actualOutput }, null, 2),
  aggregate: aggregateTextConcisenessScore,
  pointScore: POINT_SCORES,
});

export function runTextConcisenessPreset(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  return runTextJudge(DEFINITION, user, ctx);
}
