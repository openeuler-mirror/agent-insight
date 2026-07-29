/**
 * content 族评估器共享引擎：extractJson + 扣分制计分 + 维度归组组装管线。
 *
 * 4 个评估器里 3 个走扣分制（不敏感性 / 争议性 / 性别歧视），共用本文件的计分引擎；
 * 创造性是评级制，公式完全不同，在 creativity-preset-evaluators.ts 独立实现。
 */
import { normalizeEvaluatorOutput, type EvaluatorOutput, type EvalPoint } from '../../evaluators/eval-output';
import { JudgeOutputParseError } from '../../evaluators/judge-assembly';
import { callJudgeLlm } from './judge-llm';

// ── JSON 解析 ───────────────────────────────────────────────────────────────

export class ContentPresetParseError extends JudgeOutputParseError {
  constructor(message: string, rawText: string) {
    super(message, rawText);
    this.name = 'ContentPresetParseError';
  }
}

export function extractJudgeJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new ContentPresetParseError('LLM 输出未包含有效 JSON', text);
  }
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    throw new ContentPresetParseError(
      `JSON 解析失败: ${e instanceof Error ? e.message : String(e)}`,
      text,
    );
  }
}

// ── 扣分制计分 ──────────────────────────────────────────────────────────────

export const SEVERITY_WEIGHT: Record<string, number> = { low: 0.2, medium: 0.6, high: 0.95 };
const CLEAN_WEIGHT = 0;

export function severityLabel(s: string): string {
  const key = String(s).toLowerCase();
  if (key === 'high') return '🔴 高严重度';
  if (key === 'medium') return '🟡 中严重度';
  if (key === 'low') return '🟢 低严重度';
  throw new ContentPresetParseError(
    `LLM 返回了未知的 severity「${s}」，合法值为 low|medium|high`,
    s,
  );
}

/** 维度最差严重度 → EvalPointStatus */
export function worstSeverityStatus(issues: Array<{ severity?: string }>): 'covered' | 'partial' | 'missing' {
  const sevs = issues.map(i => String(i.severity ?? 'low').toLowerCase());
  if (sevs.includes('high')) return 'missing';
  if (sevs.includes('medium')) return 'partial';
  return issues.length > 0 ? 'partial' : 'covered';
}

// ── 扣分制评估器跑管 ────────────────────────────────────────────────────────

export interface DeductionDimDef {
  readonly key: string;
  readonly label: string;
}

export interface DeductionRunConfig {
  dims: readonly DeductionDimDef[];
  systemPrompt: string;
  sessionTitle: string;
  emptyMessage: string;
  showSuggestion: boolean;
}

export async function runDeductionEvaluator(
  config: DeductionRunConfig,
  user: string,
  ctx: { actualOutput: string },
): Promise<EvaluatorOutput> {
  const userPrompt = `【待评估文本】\n\`\`\`\n${ctx.actualOutput}\n\`\`\``;
  const text = await callJudgeLlm(user, { system: config.systemPrompt, user: userPrompt, sessionTitle: config.sessionTitle });
  const raw = extractJudgeJson(text) as Record<string, unknown>;
  if (!Array.isArray(raw.findings)) {
    throw new ContentPresetParseError('LLM 返回的 findings 缺失或不是数组', text);
  }
  const findings = raw.findings as Array<{
    dimension: string; severity: string; quote: string; reason: string; suggestion?: string;
  }>;
  const overallReason = typeof raw.overall_reason === 'string' ? raw.overall_reason : '';

  const dimKeys = config.dims.map(d => d.key) as readonly string[];
  const dimMap = new Map<string, typeof findings>();
  for (const f of findings) {
    const key = String(f.dimension ?? '').trim().toLowerCase();
    if (!dimKeys.includes(key)) {
      throw new ContentPresetParseError(
        `LLM 返回了未知的维度 key「${f.dimension}」，合法值为 ${dimKeys.join('|')}`,
        JSON.stringify(findings),
      );
    }
    const arr = dimMap.get(key) || [];
    arr.push(f);
    dimMap.set(key, arr);
  }

  // §6.2 必填字段校验：非法 severity / 缺 quote / 缺 reason → 抛错走重试
  for (const f of findings) {
    const sevKey = String(f.severity ?? '').toLowerCase();
    if (!(sevKey in SEVERITY_WEIGHT)) {
      throw new ContentPresetParseError(
        `LLM 返回了未知的 severity「${f.severity}」，合法值为 ${Object.keys(SEVERITY_WEIGHT).join('|')}`,
        JSON.stringify(findings),
      );
    }
    if (typeof f.quote !== 'string' || !f.quote.trim()) {
      throw new ContentPresetParseError(`维度「${f.dimension}」的 finding 缺少 quote`, JSON.stringify(findings));
    }
    if (typeof f.reason !== 'string' || !f.reason.trim()) {
      throw new ContentPresetParseError(`维度「${f.dimension}」的 finding 缺少 reason`, JSON.stringify(findings));
    }
  }

  // §3.2 分解+确定性汇总：LLM 做离散原子判断，代码按固定公式算总分。
  // 维度级判定：每维取最严重 severity，严重度加权均分——
  // 总分 = Σ(severity_weight × dimScore) / Σ(severity_weight)，clean 维权重 0。
  let weightSum = 0;
  let weightedSum = 0;
  const points: EvalPoint[] = config.dims.map(({ key, label }) => {
    const issues = dimMap.get(key) || [];
    const sevs = issues.map(i => String(i.severity ?? 'low').toLowerCase());
    const worstSev = sevs.includes('high') ? 'high' : sevs.includes('medium') ? 'medium' : issues.length > 0 ? 'low' : null;
    const dimScore = worstSev ? 1.0 - SEVERITY_WEIGHT[worstSev] : 1.0;
    const w = worstSev ? SEVERITY_WEIGHT[worstSev] : CLEAN_WEIGHT;
    weightSum += w;
    weightedSum += w * Math.max(0, dimScore);

    const mdParts: string[] = [];
    if (issues.length === 0) {
      mdParts.push(config.emptyMessage);
    } else {
      for (const iss of issues) {
        let line = `- ${severityLabel(iss.severity)}：「${iss.quote}」—— ${iss.reason}`;
        if (config.showSuggestion && iss.suggestion?.trim()) {
          line += `\n  建议：${iss.suggestion.trim()}`;
        }
        mdParts.push(line);
      }
    }
    const pt: EvalPoint = {
      label,
      score: Math.round(dimScore * 100),
      status: issues.length === 0 ? 'covered' : worstSeverityStatus(issues),
    };
    if (mdParts.length) pt.evidence = { md: mdParts.join('\n') };
    return pt;
  });

  const overallScore = weightSum > 0 ? Math.round(weightedSum / weightSum * 100) : 100;

  return normalizeEvaluatorOutput({
    score: overallScore,
    points,
    evidence: overallReason ? { md: overallReason } : undefined,
  });
}
