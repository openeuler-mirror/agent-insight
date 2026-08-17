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
  '你是一个客观答案评估器的关键信息点提取器。你的任务是从「标准答案」中提取回答该问题时必须覆盖的关键信息点。',
  '',
  '【信息点类型】',
  '- number（关键数值）：具体数字，如 42、3.14、2024 年、1234.5 亿元',
  '- term（专有名词）：专有术语或名词，如 Transformer、BERT、Python、H2O',
  '- conclusion（核心结论）：核心结论性表述，如「X 大于 Y」「A 属于 B 类」',
  '- condition（必要条件）：必须满足的条件，如「温度不能超过 100℃」',
  '',
  '【提取规则】',
  '- 一个关键数值、专有名词、核心结论或必要条件提取为一个独立信息点',
  '- 一段话包含多个并列要点时拆成多个信息点（回答可能只命中其中部分）',
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

async function extractKeyPoints(user: string, reference: string): Promise<KeyPoint[]> {
  const text = await callJudgeLlm(user, {
    system: ANSWER_MATCH_EXTRACT_SYSTEM,
    user: `【标准答案】\n\`\`\`\n${reference}\n\`\`\`\n`,
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

export function extractAllNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const n = parseFloat(m.replace(/,/g, ''));
    if (Number.isFinite(n)) out.push(n);
  }
  for (const m of text.match(/[零一二两三四五六七八九十百千万亿]+/g) ?? []) {
    const n = transferChineseNumber(m);
    if (n !== null) out.push(n);
  }
  return out;
}

function getExpectedNumber(text: string): number | null {
  const nums = extractAllNumbers(text);
  return nums.length ? nums[0] : null;
}

function matchNumber(answer: string, expected: number): 'covered' | 'partial' | 'unmatched' {
  const candidates = extractAllNumbers(answer);
  if (candidates.some((n) => Math.abs(n - expected) < 1e-6)) return 'covered';
  const expectedStr = String(expected);
  if (candidates.some((n) => {
    const s = String(n);
    return s.length < expectedStr.length && expectedStr.startsWith(s);
  })) return 'partial';
  return 'unmatched';
}

function matchTerm(answer: string, term: string): 'covered' | 'unmatched' {
  const a = answer.replace(/[\s\-_]/g, '').toLowerCase();
  const t = term.replace(/[\s\-_]/g, '').toLowerCase();
  if (!t) return 'unmatched';
  return a.includes(t) ? 'covered' : 'unmatched';
}

function codeMatchPoint(answer: string, point: KeyPoint): { status: 'covered' | 'partial' | 'pending'; evidence: string } {
  if (point.type === 'number') {
    const expected = getExpectedNumber(point.text);
    if (expected !== null) {
      const m = matchNumber(answer, expected);
      if (m === 'covered') return { status: 'covered', evidence: `代码层精确匹配：回答包含数值 ${expected}` };
      if (m === 'partial') {
        const hit = extractAllNumbers(answer).find((n) => String(expected).startsWith(String(n)) && String(n).length < String(expected).length);
        return { status: 'partial', evidence: `代码层部分匹配：回答数值 ${hit ?? '?'} 仅为标准数值 ${expected} 的截断，精度不足` };
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
  '- 回答明确表达相反含义、或完全遗漏该信息 → not_matched',
  '- 无法确定是否覆盖 → uncertain',
  '',
  '【输出格式】只输出一个 JSON 对象，不要额外文字：',
  '{',
  '  "judgments": [ {"point": "<信息点原文>", "result": "matched|not_matched|uncertain", "reason": "判定依据（中文，引用回答中的对应内容）"} ],',
  '  "overall_reason": "整体说明（中文，可选）"',
  '}',
  'result 必须使用 matched|not_matched|uncertain 之一，不得自创；point 必须使用输入列表中的原文、不得改写或遗漏。',
].join('\n');

async function judgeRemainingPoints(
  user: string,
  question: string,
  answer: string,
  reference: string,
  pending: KeyPoint[],
): Promise<Map<string, { result: string; reason: string }>> {
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
  const byPoint = new Map<string, { result: string; reason: string }>();
  for (const item of raw.judgments as unknown[]) {
    if (!item || typeof item !== 'object') continue;
    const j = item as Record<string, unknown>;
    const pointText = str(j.point).trim();
    const result = str(j.result).toLowerCase();
    if (!pointText || !['matched', 'not_matched', 'uncertain'].includes(result)) {
      throw new SimilarityJudgeParseError(
        `LLM 返回了非法的判定结果「${j.result}」，合法值为 matched|not_matched|uncertain`,
        text,
      );
    }
    byPoint.set(pointText, { result, reason: str(j.reason).trim() });
  }
  return byPoint;
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
    return normalizeEvaluatorOutput({
      verdict: 'fail',
      summary: '未标注标准参考答案，无法评估答案匹配——不记分。',
      score: 0,
      evidence: { md: '未标注标准参考答案，无法进行客观答案匹配评估。' },
    });
  }
  const answer = (ctx.actualOutput ?? '').trim();
  const question = (ctx.caseInput ?? '').trim();

  // 1. 关键信息点提取
  const keyPoints = await extractKeyPoints(user, reference);
  if (!keyPoints.length) {
    return normalizeEvaluatorOutput({
      verdict: 'warn',
      summary: '标准答案无可提取的关键信息点，无法评估——不记分。',
      score: 0,
      evidence: { md: '标准答案中未提取到关键信息点（数值/专有名词/核心结论/必要条件），无法进行答案匹配评估。' },
    });
  }

  // 2. 代码层精确匹配
  const matched: MatchedPoint[] = [];
  const pending: KeyPoint[] = [];
  for (const p of keyPoints) {
    const r = codeMatchPoint(answer, p);
    if (r.status === 'covered') matched.push({ ...p, score: 100, status: 'covered', evidence: r.evidence });
    else if (r.status === 'partial') matched.push({ ...p, score: 50, status: 'partial', evidence: r.evidence });
    else pending.push(p);
  }

  // 3. LLM 层语义判同
  if (pending.length) {
    const judgments = await judgeRemainingPoints(user, question, answer, reference, pending);
    for (const p of pending) {
      const j = judgments.get(p.text);
      if (j?.result === 'matched') {
        matched.push({ ...p, score: 100, status: 'covered', evidence: j.reason ? `LLM 层语义判同：${j.reason}` : 'LLM 层语义判同。' });
      } else if (j?.result === 'uncertain') {
        matched.push({ ...p, score: 0, status: 'missing', evidence: j.reason ? `LLM 层判定不确定：${j.reason}` : 'LLM 层判定不确定。' });
      } else {
        matched.push({ ...p, score: 0, status: 'missing', evidence: j?.reason ? `LLM 层判定不匹配：${j.reason}` : 'LLM 层判定不匹配。' });
      }
    }
  }

  // 4. 综合评分
  const { score, base } = computeAnswerMatchScore(matched);
  const coveredCount = matched.filter((m) => m.status === 'covered').length;
  const partialCount = matched.filter((m) => m.status === 'partial').length;
  const missing = matched.filter((m) => m.status === 'missing').map((m) => `${POINT_TYPE_LABEL[m.type] ?? m.type}「${m.text}」`);
  const verdict = score >= 80 ? 'pass' : score >= 60 ? 'warn' : 'fail';

  const summary = missing.length === 0
    ? `关键信息点 ${matched.length} 个全部覆盖（含 ${partialCount} 个部分覆盖）——答案与标准答案一致。`
    : `关键信息点 ${matched.length} 个中覆盖 ${coveredCount + partialCount} 个（得分 ${score}），遗漏${missing.length ? `：${missing.slice(0, 2).join('、')}${missing.length > 2 ? ' 等' : ''}` : ''}。`;

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