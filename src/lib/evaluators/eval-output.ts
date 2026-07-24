/**
 * 评估器输出统一契约（实验域单一事实来源）。
 *
 * 评估器每次评估仅上报三样，全部可选、任意退化组合合法：
 *   { score?, points?, evidence? }
 * - score：0-100 总分。有分 → 计入综合分/类目均分；无分 → 只展示原因、不入均分。
 *   这是平台唯一的聚合字段——布尔/枚举/比值等内部形态由评估器自行折算，平台不感知。
 * - points：评分点列表。来源评估器自定（固定维度，或按 case 动态提取的判断点），
 *   平台不区分来源，统一按 label + score? + evidence? 渲染。
 * - evidence：证据，{md} 或 {json} 二选一，由字段自识别渲染格式（界面不展示格式标记）。
 *
 * 评估器名/标签/类目是注册时元数据（见 registry.ts），不随结果上报。
 * 「评估失败」由平台调用层记录（ExperimentEvalResult.status='failed'），不属于本契约。
 */
import { z } from 'zod';

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
  score: z.number().min(0).max(100).optional(),
  points: z.array(EvalPointSchema).max(64).optional(),
  evidence: EvidenceSchema.optional(),
});
export type EvaluatorOutput = z.infer<typeof EvaluatorOutputSchema>;

/**
 * 宽容归一化：接收评估器（尤其 LLM 文本解析后）的松散产物，收敛为合法契约。
 * - score 越界 → clamp 到 [0,100]；非数值 → 丢弃（等价"无分"）
 * - 0-1 量纲自动放大：score ∈ (0,1] 且非整数概率形态时按 ×100 处理（兼容旧评估器 0.0~1.0 约定）
 * - 非法评分点逐条丢弃而非整体失败
 */
export function normalizeEvaluatorOutput(raw: unknown): EvaluatorOutput {
  const out: EvaluatorOutput = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;

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

/** 类目均分口径：仅计入"有分"的结果；无分（含评估失败）不进分母。 */
export function averageScore(outputs: Array<{ score?: number | null }>): number | null {
  const scored = outputs.filter((o) => typeof o.score === 'number');
  if (!scored.length) return null;
  const sum = scored.reduce((a, o) => a + (o.score as number), 0);
  return Math.round((sum / scored.length) * 10) / 10;
}
