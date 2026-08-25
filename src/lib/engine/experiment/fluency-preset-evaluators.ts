/**
 * “文本流畅度”预置评估器（preset-fluency-text）。
 *
 * 算法（指南 §3.2 分解 + 确定性汇总）：
 * 1. LLM Judge 只做离散原子判断：按五个维度输出问题清单（dimension + severity 枚举 + 原文引用）。
 * 2. 扣分查表：语句通顺度 5/10/20、重复与冗余 5/7/10、断句与节奏 5/7/10、
 *    语义连贯性 5/10/15、语言自然度 5/7/10（light/moderate/severe）；
 *    重复类 issue 按 count（出现次数）虚拟展开逐次计分（需求「每处」口径）。
 * 3. 「连续出现的中度问题，第 4 处起扣分 ×2」：按 count 展开后的顺序扫描连续
 *    中度段，段内前 3 处不翻倍，第 4 处起（>3）加倍；严重问题不参与加倍。不设封顶。
 * 4. score = max(0, 100 - Σ扣分)，保留一位小数；0 分必须保留（typeof number 判断）。
 * 5. Judge 输出缺维度 / 未知 severity / 空 quote / 空 reason 时由 zod 严格解析抛
 *    JudgeOutputParseError（engine 自动重试），不做兜底默认档。
 *
 * prompt 内联在本文件（与 depth 族一致），不建独立 prompt 文件。
 */
import { z } from 'zod';
import {
  normalizeEvaluatorOutput,
  type EvalPoint,
  type EvaluatorOutput,
} from '@/lib/evaluators/eval-output';
import { JudgeOutputParseError } from '@/lib/evaluators/judge-assembly';
import { roundScore } from './specialized-evaluator-common';
import { invokeSpecializedJudge } from './specialized-evaluator-common';
import type { FaithfulPresetContext } from './faithful-preset-evaluators';

export const FLUENCY_PRESET_IDS = ['preset-fluency-text'] as const;
export type FluencyPresetId = (typeof FLUENCY_PRESET_IDS)[number];
export function isFluencyPresetId(id: string): id is FluencyPresetId {
  return (FLUENCY_PRESET_IDS as readonly string[]).includes(id);
}

/** 五个维度 key（顺序即 points/报告的固定维度顺序）。 */
const FLUENCY_DIMENSIONS = [
  'sentence_smoothness',
  'repetition_and_redundancy',
  'sentence_break_and_rhythm',
  'semantic_coherence',
  'language_naturalness',
] as const;
export type FluencyDimension = (typeof FLUENCY_DIMENSIONS)[number];

const FLUENCY_SEVERITIES = ['light', 'moderate', 'severe'] as const;
export type FluencySeverity = (typeof FLUENCY_SEVERITIES)[number];

const FLUENCY_DIMENSION_LABELS: Record<FluencyDimension, string> = {
  sentence_smoothness: '语句通顺度',
  repetition_and_redundancy: '重复与冗余',
  sentence_break_and_rhythm: '断句与节奏',
  semantic_coherence: '语义连贯性',
  language_naturalness: '语言自然度',
};

const FLUENCY_SEVERITY_LABELS: Record<FluencySeverity, string> = {
  light: '轻微',
  moderate: '中度',
  severe: '严重',
};

/** 计分档位（需求离散化，决策 3）——严格按需求原文，不额外调整。 */
const FLUENCY_DEDUCTIONS: Record<FluencyDimension, Record<FluencySeverity, number>> = {
  sentence_smoothness: { light: 5, moderate: 10, severe: 20 },
  repetition_and_redundancy: { light: 5, moderate: 7, severe: 10 },
  sentence_break_and_rhythm: { light: 5, moderate: 7, severe: 10 },
  semantic_coherence: { light: 5, moderate: 10, severe: 15 },
  language_naturalness: { light: 5, moderate: 7, severe: 10 },
};

// ── Judge 契约（类型层宽容：issue 为字符串时 preprocess 包成 {quote}；
//    语义层严格：缺维度 / 未知 severity / 空 quote / 空 reason 一律解析失败）──

const fluencyIssueSchema = z.preprocess(
  (value) => (typeof value === 'string' ? { quote: value } : value),
  z.object({
    dimension: z.enum(FLUENCY_DIMENSIONS),
    severity: z.enum(FLUENCY_SEVERITIES),
    quote: z.string().min(1),
    reason: z.string().min(1),
    suggestion: z.string().default(''),
    count: z.number().int().min(1).max(20).default(1),
  }).superRefine((value, ctx) => {
    // 有分必有据（指南 §6.2）：severe 问题必须带修改建议
    if (value.severity === 'severe' && !value.suggestion.trim()) {
      ctx.addIssue({ code: 'custom', path: ['suggestion'], message: 'severe 问题必须提供修改建议' });
    }
  }),
);

const fluencySchema = z.object({
  issues: z.array(fluencyIssueSchema).default([]),
  confidence: z.number().min(0).max(1).default(0),
});

export interface FluencyIssue {
  dimension: FluencyDimension;
  severity: FluencySeverity;
  quote: string;
  reason: string;
  suggestion: string;
  /** 同一表达重复出现次数（仅重复与冗余类必填，其余维度缺省 1），计分按 count 虚拟展开逐次扣分 */
  count: number;
}

/** 入参形态 = schema 原始输入（preprocess 使 issue 元素为 unknown），语义校验在 buildFluencyOutput 内 safeParse。 */
export type FluencyJudgeResult = z.input<typeof fluencySchema>;

// ── Prompt（泛化判据，禁止写死验收用例原句）────────────────────────────────

const FLUENCY_SYSTEM_PROMPT = `你是中文文本流畅度评审专家。请逐句通读用户提供的文本，找出语言表达质量问题，归入下面五个维度，输出问题清单。

## 五个维度与判据
1. sentence_smoothness 语句通顺度：句子成分残缺（缺少主语/谓语/宾语）、语序混乱（成分位置颠倒）、搭配不当（动宾/修饰搭配错误）、量词/介词/连词使用错误、句式杂糅导致读不通顺。
2. repetition_and_redundancy 重复与冗余：同一信息在短距离内反复出现、相同句式连续使用造成单调感、同义反复（多个近义词堆叠表达同一意思）、冗余的修饰词堆叠。
3. sentence_break_and_rhythm 断句与节奏：句子过长且缺少断句（超过 80 字的长句）、断句位置不当导致语义割裂、句子过短且零碎（电报体）、标点符号使用错误（逗号句号不分、引号不匹配）。
4. semantic_coherence 语义连贯性：相邻句子语义跳跃（缺少过渡）、指代不清（代词指代不明导致理解困难）、逻辑关系表达不清晰（因果/转折/并列关系混乱）、话题突然转换没有过渡句。
5. language_naturalness 语言自然度：过于书面化/生硬（全篇使用「其」「该」「之」等正式用词）、翻译腔明显（英文句式直译的欧化表达）、模板化表达过多（「值得注意的是」「综上所述」等套话反复出现）、语气和语境不匹配（正式报告中出现口语化表达）。

## 严重程度
- light：轻微瑕疵，基本不影响理解，可以改进。
- moderate：明显问题，影响部分理解或阅读体验。
- severe：严重问题，句子难以理解或语义严重混乱；整句成分残缺（找不到主语/谓语/宾语）、读不出行为主体时必须判 severe（如介词短语与使令动词连用导致整句无主语，如「通过…」「使…」连用），不得降为 moderate；长句通篇一逗到底、无任何断句时至少判 moderate。

## 规则
- 只报告确实存在的问题；无法确定时不报告。
- 每条 issue 必须引用原文片段（quote），并给出判断依据（reason）与修改建议（suggestion）。
- 按文本中出现顺序完整列出所有问题：连续出现的中度问题中，第 4 处起会被加倍扣分（连续前 3 处不翻倍；严重问题不参与加倍，按原档扣分），不要合并、不要遗漏。
- **独立缺陷才拆分上报，同一缺陷不要重复拆**：
  - 长句缺少断句 → 按最明显的 2~3 个断句不当位置各报一条，不要超过 3 条；
  - 同一修饰词/表达重复多次 → **报一条并填 count=该表达实际出现的次数**（同一修饰词出现 4 次就填 count=4，代码按 count 逐次计分、参与连续加倍；同一表达重复 3 次及以上时至少判 moderate，不得判 light；count 只用于同一词/同一表达的多次重复，同义反复即不同近义词堆叠时 count=1）；
  - 相邻句子多次话题跳跃 → **每对相邻句子的跳跃必须单列一条，禁止只报最明显的一条**（N 句互不关联就报 N-1 条，三句报 2 条、四句报 3 条）；
  - 同一句同时存在多个维度的问题（如句式杂糅 + 生硬用词）→ 各维度分别上报。
- 核心问题必须完整上报：一个文本最严重的问题（如整句无主语、三句以上完全无关联）要如实列出全部相关条目，不要只报一条。

## 输出格式
只输出 JSON 对象，不要输出任何其它文字或代码块。severity 只能是 light / moderate / severe 三值之一，dimension 只能是五个维度 key 之一，严禁使用其它值：
{
  "issues": [
    {
      "dimension": "sentence_smoothness",
      "severity": "moderate",
      "quote": "原文片段",
      "reason": "问题依据",
      "suggestion": "修改建议",
      "count": 1
    }
  ],
  "confidence": 0.9
}
count 仅「重复与冗余」类必填（该表达出现的次数），其余维度可省略。`;

function buildFluencyUserPrompt(text: string): string {
  return `请对下面这段文本做流畅度评审，输出上述格式的 JSON。文本长度上限 8000 字，超出部分已截断。

<text>
${text}
</text>`;
}

// ── 确定性计分 ──────────────────────────────────────────────────────────────

/**
 * 按 count 虚拟展开后的连续 moderate 序列扫描：展开位段内相对位置 >3（第 4 处起）
 * 计为加倍，返回每条 issue 命中的加倍位置数。连续加倍只对「连续出现的中度问题」
 * 生效（需求原文口径：连续 3 处以上中度问题扣分加倍）；严重问题不参与连续段、
 * 不触发加倍，按原档扣分。不设封顶。
 */
function countDoubledPositions(issues: FluencyIssue[]): Map<number, number> {
  const expanded: Array<{ issueIndex: number; severity: FluencySeverity }> = [];
  issues.forEach((issue, index) => {
    for (let c = 0; c < issue.count; c += 1) expanded.push({ issueIndex: index, severity: issue.severity });
  });
  const doubledByIssue = new Map<number, number>();
  const n = expanded.length;
  let i = 0;
  while (i < n) {
    if (expanded[i].severity !== 'moderate') {
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && expanded[j].severity === 'moderate') j += 1;
    for (let k = i + 3; k < j; k += 1) {
      const issueIndex = expanded[k].issueIndex;
      doubledByIssue.set(issueIndex, (doubledByIssue.get(issueIndex) ?? 0) + 1);
    }
    i = j;
  }
  return doubledByIssue;
}

/**
 * 需求口径兜底（代码侧保证，不依赖 judge 严重度判断）：同一表达重复 ≥3 次时，
 * 按「连续 3 处以上」语义至少计中度——judge 误判 light 时抬升为 moderate，
 * 避免重复累加被按轻微档系统性低估。
 */
function withRepetitionSeverityFloor(issue: FluencyIssue): FluencyIssue {
  if (issue.dimension === 'repetition_and_redundancy' && issue.count >= 3 && issue.severity === 'light') {
    return { ...issue, severity: 'moderate' };
  }
  return issue;
}

interface FluencyIssueItem {
  deduction: number;
  doubled: boolean;
  issue: FluencyIssue;
}

interface FluencyDimensionAggregate {
  dimension: FluencyDimension;
  label: string;
  deduction: number;
  items: FluencyIssueItem[];
}

function buildDimensionIssueMd(agg: FluencyDimensionAggregate): string {
  const lines = agg.items.map(({ deduction, doubled, issue }) => {
    const suggestion = issue.suggestion.trim()
      ? `\n  建议：${issue.suggestion.trim()}`
      : '';
    const doubledNote = doubled ? '（连续第 4 处起，扣分加倍）' : '';
    const occurrence = issue.count > 1 ? `（重复 ${issue.count} 次）` : '';
    return `- [${FLUENCY_SEVERITY_LABELS[issue.severity]}] 「${issue.quote}」—— ${issue.reason}${occurrence}（扣 ${deduction} 分${doubledNote}）${suggestion}`;
  });
  return `问题 ${agg.items.length} 处，共扣 ${agg.deduction} 分\n${lines.join('\n')}`;
}

function buildFluencyReportMd(
  score: number,
  aggregates: FluencyDimensionAggregate[],
  totalDeduction: number,
): string {
  const rows = aggregates.map((agg) =>
    `| ${agg.label} | ${Math.max(0, 100 - agg.deduction)} | ${agg.deduction} | ${agg.items.length} |`);
  const sections = aggregates
    .filter((agg) => agg.deduction > 0)
    .map((agg) => `### ${agg.label}（扣 ${agg.deduction} 分）\n${buildDimensionIssueMd(agg)}`);
  return [
    '# 文本流畅度评估报告',
    '',
    `**总分：${score} / 100（${fluencyTier(score)}）**${totalDeduction > 0 ? `（共扣 ${totalDeduction} 分）` : '（未发现问题，无扣分）'}`,
    '',
    '## 各维度汇总',
    '',
    '| 维度 | 得分 | 扣分 | 问题数 |',
    '|---|---|---|---|',
    ...rows,
    ...(sections.length
      ? ['', '## 问题清单', '', ...sections]
      : ['', '未发现明显流畅度问题。']),
  ].join('\n');
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** 流畅度四档（需求评分规则）：>=90 总体流畅 / 70~90 基本流畅 / 40~70 不流畅 / <40 严重不流畅。 */
export function fluencyTier(score: number): string {
  if (score >= 90) return '总体流畅';
  if (score >= 70) return '基本流畅';
  if (score >= 40) return '不流畅';
  return '严重不流畅';
}

/** summary ≤80 字，说人话，只讲最要命的一条。 */
function buildFluencySummary(issues: FluencyIssue[]): string {
  if (issues.length === 0) return '未发现明显流畅度问题，文本整体通顺。';
  const severityRank: Record<FluencySeverity, number> = { light: 0, moderate: 1, severe: 2 };
  const worst = issues.reduce((a, b) => (severityRank[b.severity] > severityRank[a.severity] ? b : a));
  const label = FLUENCY_DIMENSION_LABELS[worst.dimension];
  const quote = clip(worst.quote, 20);
  const reason = clip(worst.reason, 36);
  return `最严重问题：${label}「${quote}」——${reason}`;
}

/**
 * 确定性计分纯函数（供测试直接调用）。
 * 空文本/空白 → { score: 100, summary: '空文本，跳过流畅度评估' }。
 * 语义层校验：缺维度 / 未知 severity / 空 quote / 空 reason → 抛 JudgeOutputParseError，
 * 禁止兜底默认档（引擎据此重试）。judged 为宽松输入形态，本函数先 safeParse 再计分。
 */
export function buildFluencyOutput(judged: FluencyJudgeResult, text: string): EvaluatorOutput {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return normalizeEvaluatorOutput({ score: 100, summary: '空文本，跳过流畅度评估' });
  }
  const parsed = fluencySchema.safeParse(judged);
  if (!parsed.success) {
    const details = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    throw new JudgeOutputParseError(`judge 输出不符合流畅度契约: ${details}`, JSON.stringify(judged));
  }
  const issues: FluencyIssue[] = parsed.data.issues.map(withRepetitionSeverityFloor);
  const doubledCounts = countDoubledPositions(issues);
  const aggregates: FluencyDimensionAggregate[] = FLUENCY_DIMENSIONS.map((dimension) => ({
    dimension,
    label: FLUENCY_DIMENSION_LABELS[dimension],
    deduction: 0,
    items: [],
  }));
  const aggregateOf = new Map<FluencyDimension, FluencyDimensionAggregate>(
    aggregates.map((agg) => [agg.dimension, agg]),
  );
  for (const [index, issue] of issues.entries()) {
    const base = FLUENCY_DEDUCTIONS[issue.dimension][issue.severity];
    const doubledPositions = doubledCounts.get(index) ?? 0;
    const deduction = base * issue.count + base * doubledPositions;
    const isDoubled = doubledPositions > 0;
    const agg = aggregateOf.get(issue.dimension)!;
    agg.deduction += deduction;
    agg.items.push({ deduction, doubled: isDoubled, issue });
  }
  const totalDeduction = aggregates.reduce((sum, agg) => sum + agg.deduction, 0);
  const score = roundScore(100 - totalDeduction);

  const points: EvalPoint[] = aggregates.map((agg) => ({
    label: agg.label,
    score: Math.max(0, 100 - agg.deduction),
    status: agg.deduction > 0 ? 'missing' : 'covered',
    evidence: {
      md: agg.deduction > 0 ? buildDimensionIssueMd(agg) : '该维度未发现明显问题。',
    },
  }));

  return normalizeEvaluatorOutput({
    score,
    summary: buildFluencySummary(issues),
    points,
    evidence: { md: buildFluencyReportMd(score, aggregates, totalDeduction) },
  });
}

export async function runFluencyPreset(
  id: FluencyPresetId,
  user: string,
  ctx: FaithfulPresetContext,
): Promise<EvaluatorOutput> {
  const text = (ctx.actualOutput ?? '').trim();
  if (!text) {
    return normalizeEvaluatorOutput({ score: 100, summary: '空文本，跳过流畅度评估' });
  }
  const judged = await invokeSpecializedJudge(
    user,
    {
      system: FLUENCY_SYSTEM_PROMPT,
      user: buildFluencyUserPrompt(text),
      stage: 'fluency',
    },
    fluencySchema,
  );
  return buildFluencyOutput(judged, text);
}
