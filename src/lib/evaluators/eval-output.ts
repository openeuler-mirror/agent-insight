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

/** 评分点：label 必填；score 可选（纯定性判断点）；evidence 可选。 */
export const EvalPointSchema = z.object({
  label: z.string().min(1).max(120),
  score: z.number().min(0).max(100).optional(),
  evidence: EvidenceSchema.optional(),
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
      if (!p || typeof p !== 'object') continue;
      const pr = p as Record<string, unknown>;
      const label = typeof pr.label === 'string' ? pr.label.trim().slice(0, 120) : '';
      if (!label) continue;
      const pt: EvalPoint = { label };
      const ps = coerceScore(pr.score);
      if (ps !== undefined) pt.score = ps;
      const ev = coerceEvidence(pr.evidence);
      if (ev) pt.evidence = ev;
      pts.push(pt);
    }
    if (pts.length) out.points = pts;
  }

  const ev = coerceEvidence(r.evidence);
  if (ev) out.evidence = ev;
  return out;
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
