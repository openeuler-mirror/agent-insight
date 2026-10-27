/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * 客观答案匹配评估器（preset-similarity-answer-match）
 * 
 * 分为四个阶段:
 *    1. 关键信息点提取(LLM)
 *    2. 代码层精确匹配
 *    3. LLM 层语义判同
 *    4. 综合评分
 */
import { callJudgeLlm } from './judge-llm';
import { normalizeEvaluatorOutput, type EvaluatorOutput, type EvalPoint } from '../../evaluators/eval-output';
import { SimilarityJudgeParseError, extractJson, str } from './similarity-preset-evaluators'
import type { FaithfulPresetContext } from './faithful-preset-evaluators';


const POINT_TYPE_LABEL: Record<string, string> = {
  number: '关键数值',
  term: '专有名词',
  conclusion: '核心结论',
  condition: '必要条件',
};
const POINT_TYPE_KEYS = Object.keys(POINT_TYPE_LABEL);

interface KeyPoint {
  type: string;
  text: string;
}
interface MatchedPoint extends KeyPoint {
  score: number;
  status: 'covered' | 'partial' | 'missing';
  evidence: string;
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ── 1. 关键信息点提取 ────────────────────────────────────────────────────

const ANSWER_MATCH_EXTRACT_SYSTEM = [
  '你是一个客观答案评估器的关键信息点提取器。你的任务是从「标准答案」中提取回答「用户问题」时必须覆盖的关键信息点。',
  '',
  '【信息点类型】',
  '- number（关键数值）：具体数字，如 42、3.14、2024 年、1234.5 亿元；数值带单位时必须连同单位一起提取',
  '- term（专有名词）：专有术语或名词，如 Transformer、BERT、Python、H2O',
  '- conclusion（核心结论）：核心结论性表述，如「X 大于 Y」「A 属于 B 类」',
  '- condition（必要条件）：必须满足的条件，如「温度不能超过 100℃」',
  '',
  '【提取规则】',
  '- 一个关键数值、专有名词、核心结论或必要条件提取为一个独立信息点',
  '- 一段话包含多个并列要点时拆成多个信息点（回答可能只命中其中部分）',
  '- 只提取回答「用户问题」必须覆盖的信息点：标准答案中的背景介绍、补充说明、与问题无关的细节不要提取',
  '- 不要提取与回答问题无关的修饰性内容',
  '- 若标准答案没有可提取的信息点，points 输出空数组',
  '',
  '【输出格式】只输出一个 JSON 对象，不要额外文字：',
  '{',
  '  "points": [ {"type": "number|term|conclusion|condition", "text": "信息点内容"} ],',
  '  "extraction_reason": "提取说明（中文，可选）"',
  '}',
  'type 必须使用上述四个取值之一，不得自创。',
].join('\n');

async function extractKeyPoints(user: string, question: string, reference: string): Promise<KeyPoint[]> {
  const text = await callJudgeLlm(user, {
    system: ANSWER_MATCH_EXTRACT_SYSTEM,
    user: [
      question ? `【用户问题】\n${question}` : '',
      `【标准答案】\n\`\`\`\n${reference}\n\`\`\`\n`,
    ].filter(Boolean).join('\n'),
    sessionTitle: 'exp-judge-preset-similarity-extract-keypoints',
  });
  const raw = extractJson(text) as Record<string, unknown>;
  if (!Array.isArray(raw.points)) {
    throw new SimilarityJudgeParseError('LLM 返回的 points 缺失或不是数组', text);
  }
  const points: KeyPoint[] = [];
  for (const item of raw.points as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const p = item as Record<string, unknown>;
    const type = str(p.type).toLowerCase();
    const pointText = str(p.text).trim();
    if (!pointText) continue;
    if (!POINT_TYPE_KEYS.includes(type)) {
      throw new SimilarityJudgeParseError(
        `LLM 返回了未知的信息点类型「${p.type}」，合法值为 ${POINT_TYPE_KEYS.join('|')}`,
        text,
      );
    }
    points.push({ type, text: pointText });
  }
  return points;
}

// ── 2. 代码层精确匹配 ────────────────────────────────────────────────

const CN_DIGITS: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };

export function transferChineseNumber(s: string): number | null {
  if (!s) return null;
  let total = 0;
  let section = 0;
  let num = 0;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      num = CN_DIGITS[ch];
    } else if (ch in CN_UNITS) {
      const u = CN_UNITS[ch];
      if (u >= 10000) {
        section = (section + num) * u;
        total += section;
        section = 0;
        num = 0;
      } else {
        section += (num || 1) * u;
        num = 0;
      }
    } else {
      return null;
    }
  }
  const result = total + section + num;
  return result > 0 ? result : null;
}

export interface NumberOccurrence {
  value: number;
  /** 归一化单位；无单位或单位不可识别时为 null。比对只认这个字段。 */
  unit: string | null;
}

/** 同一单位的不同写法归一化到同一 key，避免 100℃ 与 100℉ 被当成等值。 */
const UNIT_ALIASES: Record<string, string> = {
  '°c': 'c', '℃': 'c', '摄氏': 'c', '摄氏度': 'c',
  '°f': 'f', '℉': 'f', '华氏': 'f', '华氏度': 'f',
  '%': '%', '％': '%',
};

/** 可识别的单位写法（按长度降序做最长匹配）。表外文本一律视为「无单位」，不参与比对。 */
const CJK_UNITS = [
  '摄氏度', '华氏度', '平方千米', '平方公里', '平方米', '立方米', '平方厘米', '立方厘米',
  '公里', '千米', '分米', '厘米', '毫米', '微米', '纳米',
  '千克', '公斤', '毫克', '毫升', '克', '吨', '升', '公顷', '亩',
  '亿元', '万元', '亿美元', '美元', '元',
  '小时', '分钟', '毫秒', '秒', '天', '年', '月', '日', '岁',
  '米', '度', '分', '时', '个', '人', '次', '倍', '条', '件', '层', '台', '辆',
].sort((a, b) => b.length - a.length);

const LATIN_UNITS = new Set([
  'km', 'dm', 'cm', 'mm', 'um', 'nm', 'kg', 'mg', 'ug', 'g', 't', 's', 'ms', 'min', 'h',
  'l', 'ml', 'kb', 'mb', 'gb', 'tb', 'hz', 'khz', 'mhz', 'ghz', 'w', 'kw', 'mw',
  'v', 'kv', 'mv', 'a', 'ma', 'pa', 'kpa', 'mpa', 'bar', 'mol', 'cal', 'kcal',
  'px', 'dpi', 'fps', 'db', 'mah', 'wh', 'kwh',
]);

const DISPLAY_UNIT: Record<string, string> = { c: '℃', f: '℉' };

const NUMERAL_RE_G = /-?\d[\d,]*(?:\.\d+)?|[零一二两三四五六七八九十百千万亿]+/g;

function matchUnit(text: string): string | null {
  const symbol = /^(°[cf]|[℃℉]|[%％])/i.exec(text);
  if (symbol) return UNIT_ALIASES[symbol[1].toLowerCase()] ?? symbol[1].toLowerCase();
  const latin = /^[A-Za-z]{1,6}/.exec(text);
  if (latin && LATIN_UNITS.has(latin[0].toLowerCase())) return latin[0].toLowerCase();
  for (const unit of CJK_UNITS) {
    if (text.startsWith(unit)) return UNIT_ALIASES[unit] ?? unit;
  }
  return null;
}

/** 紧跟在数值/单位后面的一律按范围连接符处理（`100-200`、`100℃-200℃`），不当作负号。 */
const RANGE_CONNECTOR_CONTEXT = /[\d℃℉%°A-Za-z\p{Script=Han}]/u;

/** 紧跟阿拉伯数字的中文量级词（`3.5亿` → 3.5e8）；`万元`/`亿元` 是单位，不在此列。 */
const MAGNITUDE: Record<string, number> = { 千: 1e3, 万: 1e4, 亿: 1e8 };

function skipSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  return i;
}

/**
 * 提取文本中所有数值及其单位。
 * 紧跟阿拉伯数字的 千/万/亿 作为量级乘子并入数值；单位命中时优先按单位解析
 * （`3.5亿元` 仍是 3.5 亿元，不会把 `亿` 拆成量级后变成 3.5 万元）。
 * 若整段文本只出现一种单位（如「100-200℃」），则视为各数值共用该单位。
 */
export function extractNumberOccurrences(text: string): NumberOccurrence[] {
  const out: NumberOccurrence[] = [];
  let consumed = 0;
  for (const m of text.matchAll(NUMERAL_RE_G)) {
    let raw = m[0];
    let start = m.index ?? 0;
    if (start < consumed) continue;
    const prev = text[start - 1];
    if (raw.startsWith('-') && prev !== undefined && RANGE_CONNECTOR_CONTEXT.test(prev)) {
      raw = raw.slice(1);
      start += 1;
    }
    const isArabic = /^[-\d]/.test(raw);
    let value = isArabic
      ? parseFloat(raw.replace(/,/g, ''))
      : transferChineseNumber(raw);
    if (value === null || !Number.isFinite(value)) continue;
    let cursor = skipSpaces(text, start + raw.length);
    if (isArabic) {
      const run = /^[千万亿]+/.exec(text.slice(cursor));
      if (matchUnit(text.slice(cursor)) === null) {
        if (run) {
          for (const ch of run[0]) value *= MAGNITUDE[ch];
          cursor = skipSpaces(text, cursor + run[0].length);
          consumed = cursor;
        }
      } else if (run) {
        // `千米`/`千克`/`万元` 的前缀量级字属于单位写法，不能再被当成独立数值（否则 3千米 会多出一个 1000）
        consumed = cursor + run[0].length;
      }
    }
    out.push({ value, unit: matchUnit(text.slice(cursor)) });
  }
  const units = new Set(out.map((o) => o.unit).filter((u): u is string => u !== null));
  if (units.size === 1) {
    const only = units.values().next().value as string;
    for (const o of out) if (o.unit === null) o.unit = only;
  }
  return out;
}

export function extractAllNumbers(text: string): number[] {
  return extractNumberOccurrences(text).map((o) => o.value);
}

const formatNumberOccurrence = (o: NumberOccurrence) =>
  `${o.value}${o.unit ? DISPLAY_UNIT[o.unit] ?? o.unit : ''}`;

/**
 * 只认小数位上的精度截断（`3.14` 之于 `3.14159`）。
 * 整数前缀（`2` 之于 `25`、`1` 之于 `100`）是另一个数量级的错值，不能算部分覆盖。
 */
const isTruncationOf = (actual: number, expected: number) => {
  const a = String(actual);
  const e = String(expected);
  return a.includes('.') && a.length < e.length && e.startsWith(a);
};

/** 信息点未写单位时不强制回答带单位；写了单位则回答必须给出同一单位。 */
function unitCompatible(expected: string | null, actual: string | null): boolean {
  return expected === null || expected === actual;
}

interface NumberMatchDetail {
  truncated: Array<{ expected: NumberOccurrence; actual: NumberOccurrence }>;
  /** 代码层未命中（数值缺失、单位不符或无法比对）的期望数值 */
  missed: NumberOccurrence[];
}

/** 要求信息点里的每个数值都被命中，避免数值范围只核对到第一个数值。 */
function matchNumberOccurrences(answer: NumberOccurrence[], expected: NumberOccurrence[]): NumberMatchDetail {
  const detail: NumberMatchDetail = { truncated: [], missed: [] };
  for (const e of expected) {
    if (answer.some((a) => unitCompatible(e.unit, a.unit) && Math.abs(a.value - e.value) < 1e-6)) continue;
    const truncated = answer.find((a) => unitCompatible(e.unit, a.unit) && isTruncationOf(a.value, e.value));
    if (truncated) detail.truncated.push({ expected: e, actual: truncated });
    else detail.missed.push(e);
  }
  return detail;
}

const HAN = /\p{Script=Han}/u;
const LATIN_WORD = /[A-Za-z0-9]/;

/** 去掉空白 / 连字符 / 下划线后小写：`Self-Attention` 与 `self attention` 等价。 */
const normalizeTerm = (s: string) => s.replace(/[\s\-_]+/g, ' ').trim().toLowerCase();

/**
 * 专有名词命中：英文按词边界匹配（避免 `C` 命中 `CPU`），中文按子串匹配。
 * 单个汉字没有词边界可依，交 LLM 判定而非直接判覆盖。
 */
function matchTerm(answer: string, term: string): 'covered' | 'unmatched' {
  const t = normalizeTerm(term);
  if (!t) return 'unmatched';
  const a = normalizeTerm(answer);
  if (!a) return 'unmatched';
  if (HAN.test(t)) return t.length >= 2 && a.includes(t) ? 'covered' : 'unmatched';
  let idx = a.indexOf(t);
  while (idx !== -1) {
    const before = idx === 0 ? undefined : a[idx - 1];
    const after = a[idx + t.length];
    if (!(before && LATIN_WORD.test(before)) && !(after && LATIN_WORD.test(after))) return 'covered';
    idx = a.indexOf(t, idx + 1);
  }
  return 'unmatched';
}

function codeMatchPoint(answer: string, point: KeyPoint): { status: 'covered' | 'partial' | 'pending'; evidence: string } {
  if (point.type === 'number') {
    const expected = extractNumberOccurrences(point.text);
    if (expected.length) {
      const detail = matchNumberOccurrences(extractNumberOccurrences(answer), expected);
      const expectedText = expected.map(formatNumberOccurrence).join('、');
      if (!detail.missed.length && !detail.truncated.length) {
        // 未带单位的裸数值（如「3」）可能只是回答里的序号或无关数字，代码层命中不足以定档，交判同复核语境。
        if (expected.some((e) => e.unit === null)) return { status: 'pending', evidence: '' };
        return { status: 'covered', evidence: `代码层精确匹配：回答包含数值 ${expectedText}` };
      }
      if (!detail.missed.length) {
        const first = detail.truncated[0];
        return {
          status: 'partial',
          evidence: `代码层部分匹配：回答数值 ${formatNumberOccurrence(first.actual)} 仅为标准数值 ${formatNumberOccurrence(first.expected)} 的截断，精度不足`,
        };
      }
    }
  } else if (point.type === 'term' && matchTerm(answer, point.text) === 'covered') {
    return { status: 'covered', evidence: `代码层精确匹配：回答包含专有名词「${point.text}」` };
  }
  return { status: 'pending', evidence: '' };
}

// ── 3. LLM 层语义判同 ────────────────────────────────────────────────────

const ANSWER_MATCH_JUDGE_SYSTEM = [
  '你是一个客观答案匹配评估器。你的任务是判断「模型回答」是否覆盖了「标准答案」中列出的各个关键信息点。',
  '',
  '【判定规则】',
  '- 回答与信息点含义一致（含同义转述，如「A 比 B 大」vs「B 小于 A」、主动/被动语态变换、信息合并或拆分）→ matched',
  '- 信息点含数值时必须同时核对数值与单位：数值相同但单位不同且不等价（如标准「100℃」对回答「100℉」）→ not_matched；回答未写出单位但语境能确定同一量纲时按 matched 处理，无法确定则 uncertain',
  '- 回答明确表达相反含义、或完全遗漏该信息 → not_matched',
  '- 无法确定是否覆盖 → uncertain',
  '',
  '【输出格式】只输出一个 JSON 对象，不要额外文字：',
  '{',
  '  "judgments": [ {"index": 1, "result": "matched|not_matched|uncertain", "reason": "判定依据（中文，引用回答中的对应内容）"} ],',
  '  "overall_reason": "整体说明（中文，可选）"',
  '}',
  'index 是「待判定信息点」列表中的序号；每个序号必须恰好出现一次，不得遗漏、重复或自创。',
  'result 必须使用 matched|not_matched|uncertain 之一，不得自创。',
].join('\n');

const JUDGE_RESULTS = ['matched', 'not_matched', 'uncertain'] as const;
type JudgeResult = (typeof JUDGE_RESULTS)[number];

function parseJudgeResult(value: unknown): JudgeResult | null {
  const s = str(value).toLowerCase();
  return (JUDGE_RESULTS as readonly string[]).includes(s) ? (s as JudgeResult) : null;
}

/**
 * 判定结果按序号与 pending 一一对齐返回（数组下标 = pending 下标）。
 * 序号越界、判定值非法或信息点被遗漏时抛 SimilarityJudgeParseError（可重试），
 * 避免「LLM 漏返某个点」被静默当成未覆盖而扣分。
 */
async function judgeRemainingPoints(
  user: string,
  question: string,
  answer: string,
  reference: string,
  pending: KeyPoint[],
): Promise<Array<{ result: JudgeResult; reason: string }>> {
  const list = pending.map((p, i) => `${i + 1}. ${p.text}`).join('\n');
  const text = await callJudgeLlm(user, {
    system: ANSWER_MATCH_JUDGE_SYSTEM,
    user: [
      question ? `【用户问题】\n${question}` : '',
      `【模型回答】\n\`\`\`\n${answer}\n\`\`\``,
      `【标准答案】\n\`\`\`\n${reference}\n\`\`\``,
      '【待判定信息点】',
      list,
    ].filter(Boolean).join('\n\n'),
    sessionTitle: 'exp-judge-preset-similarity-llm-judge',
  });
  const raw = extractJson(text) as Record<string, unknown>;
  if (!Array.isArray(raw.judgments)) {
    throw new SimilarityJudgeParseError('LLM 返回的 judgments 缺失或不是数组', text);
  }
  const byIndex = new Map<number, { result: JudgeResult; reason: string }>();
  for (const item of raw.judgments as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const j = item as Record<string, unknown>;
    const index = typeof j.index === 'number' ? j.index : NaN;
    if (!Number.isInteger(index) || index < 1 || index > pending.length) {
      throw new SimilarityJudgeParseError(
        `LLM 返回了越界的信息点序号「${String(j.index)}」，合法范围为 1-${pending.length}`,
        text,
      );
    }
    const result = parseJudgeResult(j.result);
    if (!result) {
      throw new SimilarityJudgeParseError(
        `LLM 返回了非法的判定结果「${String(j.result)}」，合法值为 ${JUDGE_RESULTS.join('|')}`,
        text,
      );
    }
    byIndex.set(index, { result, reason: str(j.reason).trim() });
  }
  return pending.map((_, i) => {
    const j = byIndex.get(i + 1);
    if (!j) {
      throw new SimilarityJudgeParseError(`LLM 未对第 ${i + 1} 个信息点给出判定结果`, text);
    }
    return j;
  });
}

// ── 4. 综合评分 ────────────────────────────────────────────────────────────

/** 计分：base = 逐点得分均值（covered=100/partial=50/missing=0），未覆盖结论 -10、未覆盖数值 -20；base>50 且有结论缺失时上限 60。 */
function computeAnswerMatchScore(points: MatchedPoint[]): { score: number; base: number } {
  const total = points.length;
  if (!total) return { score: 0, base: 0 };
  const base = Math.round(points.reduce((s, p) => s + p.score, 0) / total);
  let deduction = 0;
  for (const p of points) {
    if (p.status === 'missing') {
      if (p.type === 'conclusion') deduction += 10;
      if (p.type === 'number') deduction += 20;
    }
  }
  let score = base - deduction;
  const missingConclusion = points.some((p) => p.type === 'conclusion' && p.status === 'missing');
  if (base > 50 && missingConclusion) score = Math.min(score, 60);
  return { score: Math.min(100, Math.max(0, Math.round(score))), base };
}

export async function runAnswerMatch(user: string, ctx: FaithfulPresetContext): Promise<EvaluatorOutput> {
  const reference = (ctx.referenceOutput ?? '').trim();
  if (!reference) {
    // 不给分：无分的结果只展示原因，不计入综合分与类目均分。
    return normalizeEvaluatorOutput({
      summary: '未标注标准参考答案，无法评估答案匹配——不记分。',
      evidence: { md: '未标注标准参考答案，无法进行客观答案匹配评估，本次不记分（不计入综合分与类目均分）。' },
    });
  }
  const answer = (ctx.actualOutput ?? '').trim();
  const question = (ctx.caseInput ?? '').trim();

  // 1. 关键信息点提取
  const keyPoints = await extractKeyPoints(user, question, reference);
  if (!keyPoints.length) {
    return normalizeEvaluatorOutput({
      summary: '标准答案无可提取的关键信息点，无法评估——不记分。',
      evidence: { md: '标准答案中未提取到关键信息点（数值/专有名词/核心结论/必要条件），无法进行答案匹配评估，本次不记分（不计入综合分与类目均分）。' },
    });
  }

  // 2. 代码层精确匹配：能定档的按原序号落位，其余记下序号交判同
  const results: Array<MatchedPoint | null> = keyPoints.map(() => null);
  const pending: Array<{ point: KeyPoint; index: number }> = [];
  keyPoints.forEach((p, index) => {
    const r = codeMatchPoint(answer, p);
    if (r.status === 'covered') results[index] = { ...p, score: 100, status: 'covered', evidence: r.evidence };
    else if (r.status === 'partial') results[index] = { ...p, score: 50, status: 'partial', evidence: r.evidence };
    else pending.push({ point: p, index });
  });

  // 3. LLM 层语义判同（judgments 与 pending 下标一一对应）
  if (pending.length) {
    const judgments = await judgeRemainingPoints(user, question, answer, reference, pending.map((x) => x.point));
    pending.forEach(({ point, index }, i) => {
      const j = judgments[i];
      const ok = j.result === 'matched';
      const layer = ok ? 'LLM 层语义判同' : j.result === 'uncertain' ? 'LLM 层判定不确定' : 'LLM 层判定不匹配';
      results[index] = {
        ...point,
        score: ok ? 100 : 0,
        status: ok ? 'covered' : 'missing',
        evidence: j.reason ? `${layer}：${j.reason}` : `${layer}。`,
      };
    });
  }

  // 报告按标准答案的信息点顺序展开，不按判定来源重排
  const matched = results.filter((m): m is MatchedPoint => m !== null);

  // 4. 综合评分
  const { score, base } = computeAnswerMatchScore(matched);
  const coveredCount = matched.filter((m) => m.status === 'covered').length;
  const partialCount = matched.filter((m) => m.status === 'partial').length;
  const missing = matched.filter((m) => m.status === 'missing').map((m) => `${POINT_TYPE_LABEL[m.type] ?? m.type}「${m.text}」`);
  const verdict = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail';

  // 部分覆盖只有 50 分，不能让 summary 说成「与标准答案一致」而与 verdict 打架。
  const coverage = [
    `${coveredCount} 个完全覆盖`,
    partialCount ? `${partialCount} 个部分覆盖（精度不足）` : '',
    missing.length ? `${missing.length} 个遗漏` : '',
  ].filter(Boolean).join('、');
  const summary = missing.length === 0 && partialCount === 0
    ? `关键信息点 ${matched.length} 个全部覆盖——答案与标准答案一致。`
    : `关键信息点 ${matched.length} 个：${coverage}（得分 ${score}）`
      + (missing.length ? `，遗漏${missing.slice(0, 2).join('、')}${missing.length > 2 ? ' 等' : ''}。` : '。');

  const evidenceMd = [
    `综合评分：${score}/100（信息点覆盖基准 ${base}，扣分调整 ${score - base >= 0 ? '+' : ''}${score - base}）`,
    '',
    '逐信息点判定：',
    ...matched.map((m, i) => {
      const typeLabel = POINT_TYPE_LABEL[m.type] ?? m.type;
      const statusText = m.status === 'covered' ? '已覆盖' : m.status === 'partial' ? '部分覆盖' : '未覆盖';
      return `${i + 1}. [${typeLabel}] ${m.text} —— ${statusText}（${m.score} 分）\n   ${m.evidence}`;
    }),
  ].join('\n');

  const points: EvalPoint[] = matched.map((m) => ({
    label: `${POINT_TYPE_LABEL[m.type] ?? m.type}：${truncate(m.text, 80)}`,
    score: m.score,
    status: m.status,
    evidence: { md: m.evidence },
  }));

  return normalizeEvaluatorOutput({
    verdict,
    summary,
    score,
    points,
    evidence: { md: evidenceMd },
  });
}