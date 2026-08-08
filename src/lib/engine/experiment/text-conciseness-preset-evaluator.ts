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
