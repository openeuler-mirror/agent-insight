/**
 * creativity 族预置评估器：创造性（唯一成员）。
 *
 * 创造性是评级制（1-3 档锚定），公式与扣分制完全不同，因此独立成族。
 * JSON 解析复用 content-judge-common 的 extractJudgeJson。
 */
import { normalizeEvaluatorOutput, type EvaluatorOutput, type EvalPoint } from '../../evaluators/eval-output';
import { extractJudgeJson, ContentPresetParseError } from './content-judge-common';
import { callJudgeLlm } from './judge-llm';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';

// ═══════════════════════════════════════════════════════════════════════════════
// 评估维度
// ═══════════════════════════════════════════════════════════════════════════════

const CREATIVITY_DIMS = [
  { key: 'novelty', label: '新颖性' },
  { key: 'perspective_uniqueness', label: '视角独特性' },
  { key: 'non_template_expression', label: '表达非模板化' },
  { key: 'idea_diversity', label: '构思差异度' },
  { key: 'rhetoric_quality', label: '文采与修辞' },
] as const;

const CREATIVITY_SYSTEM = [
  '你是一个专业的文本创造性评估器。你的任务是评估 Agent 生成文本的创造性水平。',
  '',
  '【评估维度与标准（1-3 评级，对齐系统三档口径）——必须逐一审查全部 5 个维度】',
  '',
  '1. 新颖性（novelty）：文本是否提供了新的观点、角度或信息，而非重复常见套路。',
  '   1 分（低）：内容完全来自常见模板或套话，无任何超出预期的信息',
  '   2 分（中）：有一些新意或尝试跳出套话，但整体仍偏保守、可预见',
  '   3 分（高）：提供了独特的新视角或突破性观点，超出预期',
  '',
  '2. 视角独特性（perspective_uniqueness）：文本是否采用了独特的思考角度或表达视角。',
  '   1 分（低）：仅从最显而易见的角度切入，视角单一，无任何转折或层次递进',
  '   2 分（中）：尝试了不同角度但展开不深，或偶有独特观察但整体仍主流',
  '   3 分（高）：多角度、多层次分析，有出人意料的观察或联想',
  '',
  '3. 表达非模板化（non_template_expression）：语言表达是否摆脱了常见模板和套话。',
  '   【极度重要——这是最容易判错的维度，请仔细核对以下模板标志】',
  '   1 分（低）：出现 ≥3 个以下模板标志：',
  '     - 序号列举模板："第一…第二…第三…""首先…其次…最后…"（内容无实质展开时尤甚）',
  '     - 结论套话："总的来说""综上所述""总而言之""概括而言"',
  '     - AI 衔接模板："值得注意的是""不可否认""毫无疑问""在当今…时代/背景下""可以说""不言而喻"',
  '     - 空泛总结："具有重要意义""值得推荐""正在深刻影响"',
  '     - 万能结尾："我们需要重视/关注""是未来的发展方向"',
  '   2 分（中）：出现 1-2 个模板标志，部分表达自然但仍有套路痕迹',
  '   3 分（高）：表达自然流畅，无模板化套路，句式变化丰富',
  '',
  '4. 构思差异度（idea_diversity）：文本中不同构思之间的差异程度和丰富性。',
  '   1 分（低）：全文围绕单一观点反复展开，信息密度低。即使列出"第一/第二/第三"，如果只是同义反复或浅层枚举，仍判 1 分',
  '   2 分（中）：有两到三个不同角度或论据类型，但深度不足',
  '   3 分（高）：多角度构思丰富，论据类型多样，信息密度高',
  '',
  '5. 文采与修辞（rhetoric_quality）：语言运用上的艺术性和表现力。',
  '   1 分（低）：语言平铺直叙，用词贫乏，缺乏节奏感。典型表现：全是简单句堆砌，无任何修辞手法',
  '   2 分（中）：用词尚可，偶有亮点但整体缺乏感染力和记忆点',
  '   3 分（高）：修辞手法运用恰当（比喻、排比、类比等），语言有感染力和记忆点',
  '',
  '【工作流程——按顺序执行，不可跳过任何一步】',
  '第一步：阅读用户需求（如有），判断输出是否只是对需求的浅层满足（如产品介绍只列三条通用优点）',
  '第二步：逐句扫描模板标志词（"第一""首先""总的来说""值得注意的是""在当今""可以说"等）',
  '第三步：检查内容是否有实质细节。例如"性能强劲"如果没有具体参数/场景支撑，就是空洞套话',
  '第四步：对 5 个维度逐一打分。模板化文本通常 novelty 和 non_template_expression 同时低分',
  '',
  '【特殊场景】',
  '- 重复常见名言或引用作为核心创意：新颖性应偏低',
  '',
  '【输出格式】只输出一个 JSON 对象，不要额外文字：',
  '{',
  '  "dimensions": {',
  '    "novelty": {"rating": 2, "comment": "评价说明（中文）"},',
  '    "perspective_uniqueness": {"rating": 2, "comment": "评价说明（中文）"},',
  '    "non_template_expression": {"rating": 2, "comment": "评价说明（中文）"},',
  '    "idea_diversity": {"rating": 2, "comment": "评价说明（中文）"},',
  '    "rhetoric_quality": {"rating": 2, "comment": "评价说明（中文）"}',
  '  },',
  '  "overall_reason": "整体创造性评价（中文）"',
  '}',
  'rating 只能是整数 1、2、3。',
].join('\n');

// ═══════════════════════════════════════════════════════════════════════════════
// 评分
// ═══════════════════════════════════════════════════════════════════════════════

const coerceRating = (key: string, v: unknown, rawText: string): number => {
  if (v === null || v === undefined) {
    throw new ContentPresetParseError(`维度「${key}」的 rating 缺失`, rawText);
  }
  if (typeof v === 'number') {
    const r = Math.round(v);
    if (r < 1 || r > 3) throw new ContentPresetParseError(`维度「${key}」的 rating 越界：${v}（合法 1-3）`, rawText);
    return r;
  }
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) {
    const r = Math.round(Number(v));
    if (r < 1 || r > 3) throw new ContentPresetParseError(`维度「${key}」的 rating 越界：${v}（合法 1-3）`, rawText);
    return r;
  }
  throw new ContentPresetParseError(`维度「${key}」的 rating 非法：${v}（应为 1-3 整数）`, rawText);
};

// ═══════════════════════════════════════════════════════════════════════════════
// 入口
// ═══════════════════════════════════════════════════════════════════════════════

export const CREATIVITY_PRESET_IDS = ['preset-creativity-expression'] as const;
export type CreativityPresetId = (typeof CREATIVITY_PRESET_IDS)[number];

export function isCreativityPresetId(id: string): id is CreativityPresetId {
  return (CREATIVITY_PRESET_IDS as readonly string[]).includes(id);
}

export async function runCreativityPreset(
  id: CreativityPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  if (id !== 'preset-creativity-expression') throw new ContentPresetParseError(`未知的 creativity id：${id}`, id);
  return runCreativity(user, ctx);
}

async function runCreativity(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  let userPrompt = `【待评估文本】\n\`\`\`\n${ctx.actualOutput}\n\`\`\``;
  if (ctx.caseInput?.trim()) {
    userPrompt = `【用户需求描述】\n${ctx.caseInput.trim()}\n\n${userPrompt}`;
  }

  const text = await callJudgeLlm(user, { system: CREATIVITY_SYSTEM, user: userPrompt, sessionTitle: 'exp-judge-creativity' });
  const raw = extractJudgeJson(text) as Record<string, unknown>;
  if (!raw.dimensions || typeof raw.dimensions !== 'object') {
    throw new ContentPresetParseError('LLM 未返回 dimensions 字段', text);
  }
  const dims = raw.dimensions as Record<string, unknown>;
  const overallReason = typeof raw.overall_reason === 'string' && raw.overall_reason.trim()
    ? raw.overall_reason.trim()
    : '';

  let totalRating = 0;
  const points: EvalPoint[] = CREATIVITY_DIMS.map(({ key, label }) => {
    const d = dims[key];
    if (!d || typeof d !== 'object') {
      throw new ContentPresetParseError(`维度「${key}」缺失，LLM 必须为全部 5 个维度提供 rating 和 comment`, text);
    }
    const rating = coerceRating(key, (d as Record<string, unknown>).rating, text);
    totalRating += rating;
    const dimScore = ((rating - 1) / 2) * 100;
    const comment = typeof (d as Record<string, unknown>).comment === 'string'
      ? String((d as Record<string, unknown>).comment).trim()
      : '';
    if (!comment) throw new ContentPresetParseError(`维度「${key}」的 comment 缺失或为空`, text);
    const pt: EvalPoint = {
      label,
      score: Math.round(dimScore),
      status: rating === 1 ? 'missing' : rating === 2 ? 'partial' : 'covered',
      evidence: { md: comment },
    };
    return pt;
  });

  return normalizeEvaluatorOutput({
    score: Math.round(((totalRating - 5) / 10) * 100),
    points,
    evidence: overallReason ? { md: overallReason } : undefined,
  });
}
