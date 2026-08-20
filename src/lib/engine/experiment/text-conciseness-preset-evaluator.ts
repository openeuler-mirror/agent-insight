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
    '即使没有 user_question，只要文本仅表达一个简单命题，却由多组同义强化词、评价性修饰或重复定语包裹，且大部分文字可删除而不损失命题信息，必须判 expression_efficiency 为 severe；不能因句子较短而降为 minor。',
    '完整操作过程若被写成一串叙述性完整句、但可在不丢失任何步骤的前提下整体压缩成简短操作路径，必须判 expression_efficiency 为 moderate，而不是 minor。',
    '简单问题中，只要直接答案没有在开头明确给出，且成因、历史、邻近话题或未请求扩展占据回复主要篇幅，必须判 main_focus 为 severe，而不是 moderate；判断以信息占比和答案是否前置为准，不机械按句数计算。',
    '若简单问题的直接结论被一整段来源、成因或背景说明推迟到该段末尾，且该结论之后又追加未请求的相邻时段、相关话题或提醒，即使背景本身真实有用，main_focus 也必须判 severe；“回答了问题”不能抵消答案未前置和扩展主导的问题。',
    '对二元或单一事实问题严格执行以下不可降档条件：若第一句不是独立的直接结论，且后文包含成因/来源/背景与至少一类未请求扩展，则 main_focus 只能为 severe，不能选择 moderate；只要两个条件同时成立，背景内容是否真实有用不影响该等级。',
    '对简单比较或单一事实问题，只要直接结论首次出现前已有一段或多句背景铺垫，且这些铺垫占回复文字的一半或以上，main_focus 必须判 severe；不要求再出现额外提醒或相邻话题，也不能因背景有事实价值而降为 moderate。',
    '对只要求二元判断或单一事实的简单问题，核心结论必须作为开头的独立短句或主句直接给出；把结论嵌在冗长的来源、成因或限定从句之后，不算答案前置。若回答还同时加入两类及以上可删除的非必要信息（如成因分析、附加指标、相邻时段、相关话题或额外提醒），必须判 main_focus 为 severe。',
    '输出前检查 severity 与自己的 reason、summary 是否一致：只要 reason 或 summary 已明确指出核心答案被多句背景延后、位于回复末尾，或未请求内容占主要篇幅，main_focus 就必须判 severe，不得一边作出该结论一边返回 minor 或 safe。',
    '操作型回答只有泛化动作，并在必要来源或版本、前置条件、关键选项、结果验证中缺少两类及以上信息，使用户无法可靠完成任务时，必须判 information_completeness 为 severe，而不是 moderate。',
    '任务依赖具体软件、文件、平台或制品，而回答只复述下载、运行、继续、完成等任何产品都适用的通用界面动作，未说明适用来源/平台、前置要求或关键选择时，属于无法实际执行的泛化步骤，information_completeness 必须判 severe。',
    '若完整操作回答的大部分从句只是在逐字展开连续的导航或点击动作，且可无损改写为一条短操作路径，expression_efficiency 必须判 moderate；不得因步骤正确、完整就判 safe。',
    '如果理由或总结已经指出两类及以上必要信息缺失，information_completeness 不得仍判 moderate；如果已经指出直接答案位于两句及以上无关背景之后，main_focus 不得仍判 moderate。',
    '同一问题优先归入最直接的维度；不得仅因缺少可选替代方案、额外确认提示或非必要补充信息而扣 information_completeness。',
    '若回复没有实质性回答或可执行内容，主体全是对话元话语、空泛评价、致谢或收束，即使没有明确 user_question，main_focus 也必须判 severe；不能只因文本语法完整而判 moderate。',
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
