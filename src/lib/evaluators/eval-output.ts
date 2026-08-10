/**
 * 评估器输出统一契约（实验域单一事实来源）。
 *
 * 评估器每次评估上报五样，全部可选、任意退化组合合法：
 *   { verdict?, summary?, score?, points?, evidence? }
 * - verdict + summary：**结论**，呈现层的主信息——一眼看懂"行不行、差在哪"。
 *   verdict 是 pass/warn/fail 三态判定，summary 是一句话说明。评分点与证据是它的
 *   展开明细，默认收起。评估器没给 verdict 时由 deriveVerdict(score) 在呈现层派生
 *   （不落库派生值，口径调整后老数据自动跟随）。
 * - score：0-100 总分。有分 → 计入综合分/类目均分；无分 → 只展示原因、不入均分。
 *   这是平台唯一的聚合字段——布尔/枚举/比值等内部形态由评估器自行折算，平台不感知。
 * - points：评分点列表。来源评估器自定（固定维度，或按 case 动态提取的判断点），
 *   平台不区分来源，统一按 label + score? + evidence? 渲染。
 * - evidence：证据，{md} 或 {json} 二选一，由字段自识别渲染格式（界面不展示格式标记）。
 *
 * 评估器名/标签/类目是注册时元数据（见 registry.ts），不随结果上报。
 * 「评估失败」由平台调用层记录（ExperimentEvalResult.status='failed'），不属于本契约。
 * 「人工修正分」是平台侧的分层字段（ExperimentEvalResult.humanScore），同样不属于本契约——
 * 评估器只管上报它自己的判断，人工意见不回流污染机器分。
 */
import { z } from 'zod';

/** 结论判定三态：达成 / 部分达成 / 未达成。 */
export const EvalVerdictSchema = z.enum(['pass', 'warn', 'fail']);
export type EvalVerdict = z.infer<typeof EvalVerdictSchema>;

/** 结论 chip 文案（列表页与详情页共用，勿在组件里各写一份）。 */
export const VERDICT_LABELS: Record<EvalVerdict, string> = {
  pass: '达成',
  warn: '部分达成',
  fail: '未达成',
};

/** summary 上限：一句话结论，超出截断（提示词里要求 ≤80 字，这里留余量兜住话痨模型）。 */
const SUMMARY_MAX = 200;

/**
 * 由分数派生结论——评估器没上报 verdict 时呈现层的兜底。
 * 80 分线沿用平台既有的「答对」口径。
 * 仅用于展示，不落库：改这里的阈值即可让全部历史数据跟随新口径。
 */
export function deriveVerdict(score: number | null | undefined): EvalVerdict | undefined {
  if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
  if (score >= 80) return 'pass';
  if (score >= 60) return 'warn';
  return 'fail';
}

/** 证据：Markdown 文本或结构化 JSON，二选一。 */
export const EvidenceSchema = z.union([
  z.object({ md: z.string().min(1) }).strict(),
  z.object({ json: z.unknown() }).strict(),
]);
export type Evidence = z.infer<typeof EvidenceSchema>;

/** 评分点覆盖/严重状态：已覆盖 / 部分覆盖 / 未覆盖（用于渲染状态 chip）。 */
export const EvalPointStatusSchema = z.enum(['covered', 'partial', 'missing']);
export type EvalPointStatus = z.infer<typeof EvalPointStatusSchema>;

/**
 * 评分点：label 必填；其余全部可选、任意组合合法。
 * - score：0-100，纯定性判断点可省
 * - evidence：证据 {md}|{json}
 * - status：覆盖/严重状态 → 状态 chip
 * - skillAttributable：能否归因到某 skill → 「可归因 skill」标签（skill 优化闭环据此挑 finding）
 * - suggestion：改进建议文本 → 证据展开后的建议行
 * - anchors：相关步骤锚点（step-N）→ 展开后可点跳链路观测
 * 归因四字段是 skill 侧（derive-skill-opt-points）读取用，代码评估器不填则一切不变。
 */
export const EvalPointSchema = z.object({
  label: z.string().min(1).max(120),
  score: z.number().min(0).max(100).optional(),
  evidence: EvidenceSchema.optional(),
  status: EvalPointStatusSchema.optional(),
  skillAttributable: z.boolean().optional(),
  suggestion: z.string().optional(),
  anchors: z.array(z.string()).max(32).optional(),
});
export type EvalPoint = z.infer<typeof EvalPointSchema>;

export const EvaluatorOutputSchema = z.object({
  verdict: EvalVerdictSchema.optional(),
  summary: z.string().min(1).max(SUMMARY_MAX).optional(),
  score: z.number().min(0).max(100).optional(),
  points: z.array(EvalPointSchema).max(64).optional(),
  evidence: EvidenceSchema.optional(),
});
export type EvaluatorOutput = z.infer<typeof EvaluatorOutputSchema>;

/**
 * 宽容归一化：接收评估器（尤其 LLM 文本解析后）的松散产物，收敛为合法契约。
 * - score 越界 → clamp 到 [0,100]；非数值 → 丢弃（等价"无分"）
 * - 0-1 量纲自动放大：score ∈ (0,1] 且非整数概率形态时按 ×100 处理（兼容旧评估器 0.0~1.0 约定）
 * - verdict 容忍中英文同义词；识别不了 → 丢弃（呈现层按 score 派生）
 * - summary 压平换行并截断到 200 字
 * - 非法评分点逐条丢弃而非整体失败
 */
export function normalizeEvaluatorOutput(raw: unknown): EvaluatorOutput {
  const out: EvaluatorOutput = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

  const verdict = coerceVerdict(r.verdict);
  if (verdict) out.verdict = verdict;

  const summary = coerceSummary(r.summary);
  if (summary) out.summary = summary;

  const score = coerceScore(r.score);
  if (score !== undefined) out.score = score;

  if (Array.isArray(r.points)) {
    const pts: EvalPoint[] = [];
    for (const p of r.points.slice(0, 64)) {
      const pt = coercePoint(p);
      if (pt) pts.push(pt);
    }
    if (pts.length) out.points = pts;
  }

  const ev = coerceEvidence(r.evidence);
  if (ev) out.evidence = ev;
  return out;
}

/** 宽容解析单个评分点（不含 children）；非法（无 label）返回 null。 */
function coercePoint(p: unknown): EvalPoint | null {
  if (!p || typeof p !== 'object') return null;
  const pr = p as Record<string, unknown>;
  const label = typeof pr.label === 'string' ? pr.label.trim().slice(0, 120) : '';
  if (!label) return null;
  const pt: EvalPoint = { label };
  const ps = coerceScore(pr.score);
  if (ps !== undefined) pt.score = ps;
  const ev = coerceEvidence(pr.evidence);
  if (ev) pt.evidence = ev;
  const st = coerceStatus(pr.status);
  if (st) pt.status = st;
  if (typeof pr.skillAttributable === 'boolean') pt.skillAttributable = pr.skillAttributable;
  if (typeof pr.suggestion === 'string' && pr.suggestion.trim()) pt.suggestion = pr.suggestion.trim();
  const anchors = coerceAnchors(pr.anchors);
  if (anchors) pt.anchors = anchors;
  return pt;
}

// verdict 归一化：容忍英文别名与中文说法；未识别 → undefined（呈现层按 score 派生）。
const VERDICT_ALIASES: Record<string, EvalVerdict> = {
  pass: 'pass', passed: 'pass', ok: 'pass', success: 'pass', met: 'pass',
  达成: 'pass', 通过: 'pass', 完成: 'pass',
  warn: 'warn', warning: 'warn', partial: 'warn', partially_met: 'warn',
  部分达成: 'warn', 部分完成: 'warn', 部分通过: 'warn',
  fail: 'fail', failed: 'fail', not_met: 'fail', miss: 'fail',
  未达成: 'fail', 未通过: 'fail', 未完成: 'fail', 失败: 'fail',
};

function coerceVerdict(v: unknown): EvalVerdict | undefined {
  if (typeof v !== 'string') return undefined;
  return VERDICT_ALIASES[v.trim().toLowerCase()];
}

/** summary 归一化：压平空白 + 截断。空串视为未提供。 */
function coerceSummary(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX - 1)}…` : s;
}

function coerceScore(v: unknown): number | undefined {
  let n: number | undefined;
  if (typeof v === 'number' && Number.isFinite(v)) n = v;
  else if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) n = Number(v);
  if (n === undefined) return undefined;
  // 兼容旧评估器 0.0~1.0 输出约定：小数量纲放大到 0-100
  if (n > 0 && n <= 1 && !Number.isInteger(n)) n = n * 100;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

// 状态归一化：容忍原评估器的 coverage 词汇（covered/partial/missing/not_applicable）
// 与中文（已覆盖/部分覆盖/未覆盖），未识别或 not_applicable → 不设 status。
function coerceStatus(v: unknown): EvalPointStatus | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'covered' || s === '已覆盖') return 'covered';
  if (s === 'partial' || s === '部分覆盖') return 'partial';
  if (s === 'missing' || s === '未覆盖') return 'missing';
  return undefined;
}

function coerceAnchors(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim()))
    .filter(Boolean).slice(0, 32);
  return out.length ? out : undefined;
}

function coerceEvidence(v: unknown): Evidence | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') return v.trim() ? { md: v } : undefined;
  if (typeof v === 'object') {
    const r = v as Record<string, unknown>;
    if (typeof r.md === 'string' && r.md.trim()) return { md: r.md };
    if ('json' in r && r.json !== undefined && r.json !== null) return { json: r.json };
    // 裸对象直接视为 json 证据
    return { json: v };
  }
  return undefined;
}

/**
 * 呈现层结论文案：优先评估器上报的 summary；取不到则回退到证据 md 的首段。
 *
 * 回退分支是为存量数据留的——契约加 summary 之前，任务完成度/轨迹质量的那句总结论
 * 一直被塞在 evidence.md 里（且详情页在有评分点时压根不渲染卡级证据，等于写了看不到）。
 * 新数据由评估器直接上报 summary，不走这里。
 */
export function displaySummary(
  summary: string | null | undefined,
  evidence: unknown,
): string | undefined {
  const direct = coerceSummary(summary);
  if (direct) return direct;
  const ev = coerceEvidence(evidence);
  if (!ev || !('md' in ev)) return undefined;
  const firstBlock = ev.md.split(/\n\s*\n/)[0] ?? '';
  return coerceSummary(firstBlock);
}

/**
 * 卡级证据是否与结论完全重复——重复就别在展开区再渲染一遍。
 *
 * 预置评估器普遍把同一段 reason 既作 summary 又作 evidence.md，不判重的话用户展开卡片
 * 看到的第一屏就是刚读过的那句话。只在**逐字相同**时判重：证据更长（说明 summary 是
 * 截断过的）时仍然渲染，免得把多出来的内容一起藏掉。
 */
export function isEvidenceRedundant(
  summary: string | null | undefined,
  evidence: unknown,
): boolean {
  const shown = displaySummary(summary, evidence);
  if (!shown) return false;
  const ev = coerceEvidence(evidence);
  if (!ev || !('md' in ev)) return false;
  return ev.md.replace(/\s+/g, ' ').trim() === shown;
}

/** 类目均分口径：仅计入"有分"的结果；无分（含评估失败）不进分母。 */
export function averageScore(outputs: Array<{ score?: number | null }>): number | null {
  const scored = outputs.filter((o) => typeof o.score === 'number');
  if (!scored.length) return null;
  const sum = scored.reduce((a, o) => a + (o.score as number), 0);
  return Math.round((sum / scored.length) * 10) / 10;
}
