import type { EvaluatorOutput } from '../../evaluators/eval-output';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';
import {
  configuredDeductionScore,
  defineTextJudgeDefinition,
  defineTextRiskAggregateConfig,
  runTextJudge,
  type TextDimension,
} from './text-judge-common';

export const TEXT_FORMAT_PRESET_ID = 'preset-text-format';

/**
 * 连续性和引用断开会破坏文档结构或可追溯性，因此是关键维度；
 * 其余维度属于普通风格/呈现问题，使用略低的扣分权重。
 */
export const TEXT_FORMAT_RISK_CONFIG = defineTextRiskAggregateConfig({
  dimensionKeys: [
    'numbering_continuity',
    'citation_mark_correctness',
    'list_hierarchy',
    'punctuation_standardization',
    'layout_consistency',
    'tabular_format',
    'special_format_correctness',
  ],
  criticalDimensionKeys: ['numbering_continuity', 'citation_mark_correctness'],
  ordinaryDimensionKeys: [
    'list_hierarchy',
    'punctuation_standardization',
    'layout_consistency',
    'tabular_format',
    'special_format_correctness',
  ],
});

const DEFINITION = defineTextJudgeDefinition({
  id: 'text-format',
  title: '文本格式规范性评估器',
  dimensions: [
    { key: 'numbering_continuity', label: '序号连续性', description: '编号跳号、重复、格式混排及同层级编号不一致；代码块中的命令序号不纳入检查。' },
    { key: 'citation_mark_correctness', label: '引用标记正确性', description: '引用格式、位置、引用列表对应关系及不存在的引用目标；需区分样式差异与引用断开。' },
    { key: 'list_hierarchy', label: '列表层级一致性', description: '嵌套列表的编号样式、缩进和父子层级是否清晰一致。' },
    { key: 'punctuation_standardization', label: '标点符号规范性', description: '中英文标点、全半角、成对符号和语言规范的一致性。' },
    { key: 'layout_consistency', label: '排版格式一致性', description: '标题层级、标题标记体系、段落间距、表格和代码块的整体排版一致性；标题标记族混用归入本维度。' },
    { key: 'tabular_format', label: '表格与结构化数据格式', description: 'Markdown 表格列数、分隔线、行列对齐和结构化数据完整性；无表格时判 safe。' },
    { key: 'special_format_correctness', label: '特殊格式正确性', description: 'URL、邮件、日期、货币和数字等特殊格式及同文统一性。' },
  ] satisfies readonly TextDimension[],
  rules: [
    '只评价 agent_output；user_question 不计入格式评分。',
    '连续性、引用断裂和无法渲染的问题比单纯风格差异扣分更重。',
    '重复编号、编号断号或跳号会破坏连续性，至少判 numbering_continuity 为 moderate；重复出现、造成顺序歧义或结构无法追踪时判 severe，不得降为 minor。',
    '不同层级采用不同编号体系本身是正常层级表达，但只适用于下层确为父标题内容中的列表项或操作步骤、且各层内部一致的情况；不得把一级章节与其下的数字步骤仅因标记不同而判为不一致。',
    '标题或小节标题同时混用三种及以上不兼容标记族（例如标记式标题、章节编号、文字符号序号、字母序号）时，必须判 layout_consistency 为 severe，即使这些标题看似处于不同层级、读者仍能猜出层级；标题不能套用“父标题下列表项”的豁免。',
    '在同一份文档的标题层级中，Markdown 标题标记与不缩进的中文序号标题、字母序号标题共同承担章节/小节标题作用时，视为不兼容标题体系；同时出现三类或以上标记族时，layout_consistency 必须判 severe，不得把中文序号或字母行降格为普通列表来规避。',
    '标点问题按影响范围判档：孤立的单个误用通常为 minor；同一短段中反复交替使用不兼容的全半角、括号、逗号或句号体系，形成系统性混用时，punctuation_standardization 至少判 moderate；多类混用共同破坏一致性时必须判 severe。',
    '成对标点只有开符号而没有闭符号，或闭合关系明显错误时，punctuation_standardization 至少判 moderate；不得把未闭合引号、括号或书名号当作轻微风格差异。',
    '同一段落用三种及以上互不兼容的表示法表达同一种日期、货币或数值数据时，special_format_correctness 至少判 moderate；不得因每个值单独可读而降为 minor。',
    '采用严格 Markdown 表格规范时，表头、分隔行和每一数据行都必须具有相同列数及完整的起止列界；分隔行或任一行缺少必要列界、导致列数无法严格对应时，tabular_format 至少判 moderate。不得只因读者可猜出单元格而判 safe。',
    '多个独立格式问题同时存在时，必须逐一返回所有受影响维度，不能只报告最显眼的一项。',
    '仅引用样式不统一、但仍能准确对应来源时通常判 minor；引用目标不存在、正文与参考文献无法对应或引用链断开时判 moderate 或 severe。',
    '没有列表、引用、表格或特殊格式时，对应维度必须判 safe，不得强行制造问题。',
  ],
  boundaryRules: [
    '先定位并从格式检查对象中排除成对三反引号或三波浪线的起止边界及其内部内容。边界内部的命令编号、关键字和代码结构强制豁免；若编号异常完全位于该边界内，numbering_continuity 必须判 safe，也不得引用为非 safe 证据。围栏外仅有引导说明和结束说明时，不构成编号列表。',
    '若理由或总结已经确认编号位于围栏代码块内、属于强制豁免或不计入检查，numbering_continuity 的 severity 字段必须填写 safe；不得在 reason 中写“判 safe”却在 severity 中填写其他等级。',
    '纯自然段文本无需额外排版规则，全部维度可判 safe。',
  ],
  buildInput: (ctx) => JSON.stringify({ agent_output: ctx.actualOutput }, null, 2),
  aggregate: (verdicts) => configuredDeductionScore(verdicts, TEXT_FORMAT_RISK_CONFIG),
});

export function runTextFormatPreset(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  return runTextJudge(DEFINITION, user, ctx);
}
