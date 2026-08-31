/**
 * LLM Judge 请求三段式组装（自建提示词评估器 + 预置 LLM 评估器共用）。
 *
 *   最终 Judge 请求 = ① 用户提示词（占位符已替换，管"怎么评"）
 *                   + ② 平台注入的评分点指令段（管"评什么"，按有无清单自动切换）
 *                   + ③ 输出约束段（管"输出形状"，锁定统一契约 JSON）
 *
 * 规则（与产品设计一致）：
 * - 用户提示词永远不被改写；评分点清单不拼接进用户提示词，作为 ② 段独立注入。
 * - 清单模式：points.label 锁定为清单原文，Judge 必须逐条给分；
 *   自由模式（清单留空）：Judge 自行提取评分点，无需用户写任何特殊描述；
 *   不适合拆点时可只给总分 + 判断依据。
 * - 输出解析走 parseJudgeText → normalizeEvaluatorOutput 宽容归一化；
 *   解析失败抛 JudgeOutputParseError（引擎侧按可重试失败处理）。
 */
import type { EvaluatorCard } from './custom-evaluator-model';
import { normalizeEvaluatorOutput, type EvaluatorOutput, type EvalPoint } from './eval-output';

/** 占位符上下文：运行时由引擎按 case 提供；缺省值以「(未提供)」替换，绝不留裸占位符。 */
export interface JudgeCaseContext {
  input?: string | null;
  /** 与实际任务输入确定性匹配的数据集 case 输入快照 */
  datasetInput?: string | null;
  output?: string | null;
  referenceOutput?: string | null;
  /** 执行轨迹序列化文本（步骤/工具调用摘要），由引擎侧提取 */
  trajectory?: string | null;
}

const PLACEHOLDER_KEYS = ['input', 'dataset_input', 'output', 'reference_output', 'trajectory'] as const;

export function replacePlaceholders(text: string, ctx: JudgeCaseContext): string {
  const values: Record<(typeof PLACEHOLDER_KEYS)[number], string> = {
    input: ctx.input?.trim() || '(未提供)',
    dataset_input: ctx.datasetInput?.trim() || '(未提供)',
    output: ctx.output?.trim() || '(未提供)',
    reference_output: ctx.referenceOutput?.trim() || '(未提供)',
    trajectory: ctx.trajectory?.trim() || '(未提供)',
  };
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (m, key: string) =>
    (PLACEHOLDER_KEYS as readonly string[]).includes(key)
      ? values[key as (typeof PLACEHOLDER_KEYS)[number]]
      : m,
  );
}

function buildPointsInstruction(pointsDef?: EvaluatorCard['pointsDef']): string {
  if (pointsDef && pointsDef.length) {
    const list = pointsDef
      .map((p, i) => `${i + 1}. ${p.label}${p.note ? `——${p.note}` : ''}`)
      .join('\n');
    return [
      '【评分点要求】请严格按以下清单逐条评估并给分，points 中每一项的 label 必须使用清单原文、不得增删：',
      list,
    ].join('\n');
  }
  return '【评分点要求】请自行提取 2~6 个评分点并逐条给分；若该任务不适合拆分评分点，可不输出 points，只给总分与判断依据。';
}

const OUTPUT_INSTRUCTION = [
  '【输出要求】只输出一个 JSON 对象，不要 Markdown 代码块、不要任何其他文字，结构如下：',
  '{"verdict": "pass|warn|fail", "summary": "<一句话结论>", "score": <0-100 整体得分>, "points": [{"label": "评分点名", "score": <0-100>, "evidence": {"md": "该点判断依据"}}], "evidence": {"md": "整体判断依据（Markdown）"}}',
  'verdict 与 summary 必填，它们是使用者唯一一定会看的内容：',
  '- verdict：pass=达成、warn=部分达成、fail=未达成；',
  '- summary：**一句话说清问题是什么**，让人看完不用再翻明细就知道发生了什么。要求：',
  '  · 说人话：不要用"覆盖率/维度/评分点/得分偏低/整体表现"这类评测术语，就当是在跟同事口头汇报；',
  '  · 先说结果、再说卡在哪，问题只讲最要命的那一条，不要罗列；',
  '  · 讲具体的东西（少了哪个数、答错成什么、漏了哪一步），不要"不够完整""质量欠佳"这种空话；',
  '  · 不要复述任务描述，不要解释你的打分过程，≤80 字。',
  '  反例：「关键观点覆盖率偏低，多个维度未达标，整体任务完成度不足。」——等于什么都没说。',
  '  正例：「攻击类型判对了，但没给出来源 IP，也漏了 root 爆破的次数，运维拿着没法直接处置。」',
  'score/points/evidence 可按实际情况省略；判断依据要引用具体内容而非空泛评价。',
].join('\n');

export interface AssembledJudgePrompt {
  system: string;
  user: string;
}

/**
 * 组装最终 judge 请求。system = 用户提示词（评估标准，占位符已替换）；
 * user = 平台指令段（评分点要求 + 输出约束，另附可选的 userPrompt 补充段）。
 */
export function buildJudgePrompt(card: EvaluatorCard, ctx: JudgeCaseContext): AssembledJudgePrompt {
  const sys = card.llmConfig?.systemPrompt ?? '';
  const userExtra = card.llmConfig?.userPrompt ?? '';
  const segments = [
    userExtra ? replacePlaceholders(userExtra, ctx) : '',
    buildPointsInstruction(card.pointsDef),
    OUTPUT_INSTRUCTION,
  ].filter(Boolean);
  return {
    system: replacePlaceholders(sys, ctx),
    user: segments.join('\n\n'),
  };
}

export class JudgeOutputParseError extends Error {
  constructor(message: string, public readonly rawText: string) {
    super(message);
    this.name = 'JudgeOutputParseError';
  }
}

/**
 * 解析 judge 文本输出 → 统一契约。容忍 ```json 代码块与前后杂文本
 * （取首个 '{' 到末个 '}' 的平衡片段）；清单模式下过滤 label 不在清单内的评分点。
 */
export function parseJudgeText(
  rawText: string,
  pointsDef?: EvaluatorCard['pointsDef'],
): EvaluatorOutput {
  const text = rawText.replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new JudgeOutputParseError('judge 输出中未找到 JSON 对象', rawText);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new JudgeOutputParseError(
      `judge 输出 JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      rawText,
    );
  }
  const out = normalizeEvaluatorOutput(parsed);
  if (pointsDef && pointsDef.length && out.points) {
    const allowed = new Set(pointsDef.map((p) => p.label));
    const filtered: EvalPoint[] = out.points.filter((p) => allowed.has(p.label));
    out.points = filtered.length ? filtered : undefined;
  }
  return out;
}
