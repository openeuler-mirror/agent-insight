/**
 * L2 LLM 评估器：4 维 SKILL.md + 1 维 工程健壮性 + 1 维 安全风险性。
 * 调用用户配置的 LLM（复用 getActiveConfig + OpenAI 客户端）。
 *
 * 2026-06 重整：
 *   - 3 个 prompt（META / ROBUSTNESS / SECURITY）改并发调用（Promise.all），15s → ~5s
 *   - bundle 太大时 ROBUSTNESS / SECURITY 按 chunk fan-out，每个 chunk 独立 prompt
 *     最后合并：score 取 min（最坏命中），issues dedup by (ruleId, hash6(evidence))
 *   - JSON 解析失败时用 jsonrepair 兜底修复，再不行才返回空
 *   - callLlm 显式设 max_tokens，防御性兜底（不影响正常响应）
 *
 * 输出：
 *   - dimensionScores: { <dim>: 1-5 }，写到 Evaluation.l2ScoresJson
 *   - issues: 拍平后的 SkillIssue 雏形列表
 */

import { OpenAI } from 'openai';
import { createHash } from 'crypto';
import { jsonrepair } from 'jsonrepair';

import { getActiveConfig } from '@/lib/storage/server-config';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import type { Severity } from '../prevalence';
import { PROMPT_SKILL_META, PROMPT_ROBUSTNESS, PROMPT_SECURITY } from './prompts';

export interface LlmIssueDraft {
  ruleId: string;            // 'dim:<dim>:<hash6>' —— 同时也是 dedupKey
  dimension: string;         // 中文维度名，如 "结构规范性"
  severity: Severity;
  summary: string;
  evidence?: string;
  reasoning?: string;        // 用 dim 的 justification 兜底
  suggestedFix?: string;
}

export interface LlmEvalOutcome {
  ok: boolean;
  errorMessage?: string;
  durationMs: number;
  dimensionScores: Record<string, number>;        // 维度名 → 1-5
  overallComments: { meta?: string; robustness?: string; security?: string };
  issues: LlmIssueDraft[];
}

const TIMEOUT_MS = Number(process.env.STATIC_EVAL_LLM_TIMEOUT_MS || 120_000);
const MAX_OUTPUT_TOKENS = 2048;

function severityFromScore(score: number): Severity | null {
  if (!Number.isFinite(score)) return null;
  if (score >= 5) return null;          // 5 = 无 issue
  if (score >= 4) return 'low';
  if (score >= 3) return 'medium';
  return 'high';
}

function normalizeSeverity(raw: unknown, fallback: Severity): Severity {
  if (raw === 'high' || raw === 'medium' || raw === 'low') return raw;
  return fallback;
}

/**
 * 解析 LLM 输出的 JSON。3 道防线：
 *   1. 直接 JSON.parse（去 markdown fence、修首尾大括号）
 *   2. jsonrepair 兜底（修未转义引号、缺括号、trailing comma 等 LLM 常见错误）
 *   3. 仍失败则抛错，由 parseDimensions 静默处理
 */
function tryParseJson(text: string): any {
  let s = (text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) s = fenced[1].trim();
  if (!s.startsWith('{')) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
  }
  try {
    return JSON.parse(s);
  } catch (e1: any) {
    // 兜底：jsonrepair 修不规范 JSON
    try {
      const repaired = jsonrepair(s);
      console.warn(`[static-eval] JSON.parse failed (${e1.message}), recovered by jsonrepair (len=${s.length})`);
      return JSON.parse(repaired);
    } catch (e2: any) {
      console.warn(`[static-eval] jsonrepair also failed: ${e2.message}; raw len=${s.length}, head=${s.slice(0, 120)}`);
      throw e1;
    }
  }
}

function hash6(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 6);
}

async function callLlm(
  client: OpenAI,
  model: string,
  prompt: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await client.chat.completions.create(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' as const },
        max_tokens: MAX_OUTPUT_TOKENS,
      },
      { signal: controller.signal },
    );
    return resp.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

interface ParsedDim {
  dimension: string;
  score: number;
  justification: string;
  issues: Array<{
    summary: string;
    severity?: string;
    evidence?: string;
    suggestedFix?: string;
  }>;
}

function parseDimensions(raw: string, defaultDimensionName: string): {
  comment: string;
  dims: ParsedDim[];
} {
  let parsed: any;
  try {
    parsed = tryParseJson(raw);
  } catch {
    return { comment: '', dims: [] };
  }
  const comment = typeof parsed?.overall_comment === 'string' ? parsed.overall_comment : '';
  const detail = Array.isArray(parsed?.detailed_evaluation) ? parsed.detailed_evaluation : [];
  const dims: ParsedDim[] = detail.map((d: any) => ({
    dimension: typeof d?.dimension === 'string' ? d.dimension : defaultDimensionName,
    score: Number(d?.score) || 0,
    justification: typeof d?.justification === 'string' ? d.justification : '',
    issues: Array.isArray(d?.issues)
      ? d.issues
          .filter((i: any) => typeof i?.summary === 'string' && i.summary.trim())
          .map((i: any) => ({
            summary: String(i.summary),
            severity: typeof i?.severity === 'string' ? i.severity : undefined,
            evidence: typeof i?.evidence === 'string' ? i.evidence : undefined,
            suggestedFix: typeof i?.suggestedFix === 'string' ? i.suggestedFix : undefined,
          }))
      : [],
  }));
  return { comment, dims };
}

function dimsToIssues(dims: ParsedDim[], section: 'meta' | 'robustness' | 'security'): LlmIssueDraft[] {
  const out: LlmIssueDraft[] = [];
  for (const d of dims) {
    const fallbackSev = severityFromScore(d.score);
    if (fallbackSev === null && d.issues.length === 0) continue;

    if (d.issues.length === 0) {
      // 兜底：score < 5 但模型没列 issues，用 justification 起一条
      const sev = fallbackSev || 'low';
      out.push({
        ruleId: `dim:${section}:${d.dimension}:${hash6(d.justification || d.dimension)}`,
        dimension: d.dimension,
        severity: sev,
        summary: `${d.dimension}：评分 ${d.score}/5`,
        evidence: undefined,
        reasoning: d.justification,
        suggestedFix: undefined,
      });
      continue;
    }

    for (const it of d.issues) {
      const sev = normalizeSeverity(it.severity, fallbackSev || 'medium');
      out.push({
        ruleId: `dim:${section}:${d.dimension}:${hash6(it.summary)}`,
        dimension: d.dimension,
        severity: sev,
        summary: it.summary,
        evidence: it.evidence,
        reasoning: d.justification,
        suggestedFix: it.suggestedFix,
      });
    }
  }
  return out;
}

/** 多 chunk 结果合并：score 取最低（最坏命中），issues 按 ruleId 去重，comment 拼接首条非空。 */
interface ChunkResult {
  comment: string;
  dimensionScores: Record<string, number>;
  issues: LlmIssueDraft[];
}

function mergeChunkResults(results: ChunkResult[]): ChunkResult {
  if (results.length === 0) return { comment: '', dimensionScores: {}, issues: [] };
  if (results.length === 1) return results[0];

  // dimensionScores: 每个维度取所有 chunk 的最低分
  const mergedScores: Record<string, number> = {};
  for (const r of results) {
    for (const [dim, score] of Object.entries(r.dimensionScores)) {
      if (mergedScores[dim] === undefined || score < mergedScores[dim]) {
        mergedScores[dim] = score;
      }
    }
  }

  // issues: 按 ruleId 去重
  const seen = new Set<string>();
  const mergedIssues: LlmIssueDraft[] = [];
  for (const r of results) {
    for (const issue of r.issues) {
      if (seen.has(issue.ruleId)) continue;
      seen.add(issue.ruleId);
      mergedIssues.push(issue);
    }
  }

  // comment: 拼接所有非空 comment（按 chunk 顺序）
  const comments = results.map(r => r.comment).filter(Boolean);
  const mergedComment = comments.length > 1
    ? comments.map((c, i) => `[chunk ${i + 1}] ${c}`).join('  ')
    : comments[0] || '';

  return { comment: mergedComment, dimensionScores: mergedScores, issues: mergedIssues };
}

export async function runLlmStaticEvaluation(args: {
  user?: string | null;
  skillContent: string;        // SKILL.md 全文
  bundleChunks: string[];      // bundle 按文件边界切的 chunks；空数组表示无附属脚本/参考
}): Promise<LlmEvalOutcome> {
  const startedAt = Date.now();
  const dimensionScores: Record<string, number> = {};
  const overallComments: LlmEvalOutcome['overallComments'] = {};
  const issues: LlmIssueDraft[] = [];

  let config: Awaited<ReturnType<typeof getActiveConfig>>;
  try {
    config = await getActiveConfig(args.user);
  } catch (e: any) {
    return {
      ok: false,
      errorMessage: `获取 LLM 配置失败: ${e?.message || e}`,
      durationMs: Date.now() - startedAt,
      dimensionScores, overallComments, issues,
    };
  }
  if (!config) {
    return {
      ok: false,
      errorMessage: '未配置可用的 LLM。请到「配置」页设置评估模型。',
      durationMs: Date.now() - startedAt,
      dimensionScores, overallComments, issues,
    };
  }

  const { customFetch } = getProxyConfig();
  const client = new OpenAI({
    apiKey: config.apiKey || 'no-api-key-required',
    baseURL: config.baseUrl || 'https://api.deepseek.com',
    fetch: customFetch as any,
  });
  const model = config.model || 'deepseek-chat';

  // 没有附属脚本/参考时，给 robustness/security 喂一个占位（仍允许它们评 SKILL.md 流程层）
  const effectiveChunks = args.bundleChunks.length > 0
    ? args.bundleChunks
    : ['(无附属脚本/参考)'];

  /**
   * 单 stage helper：调用 LLM + 解析，第一次拿到空 dims 时重试 1 次。
   * 重试动机：LLM 偶发完全无视 `response_format: json_object` 返回非 JSON 文本，
   * jsonrepair 救不了；重试一次大概率正常（实测 DeepSeek 失败率 ~10%，重试后 ~1%）。
   */
  async function callAndParse(
    prompt: string,
    defaultDim: string,
    label: string,
  ): Promise<{ comment: string; dims: ParsedDim[] }> {
    const raw = await callLlm(client, model, prompt);
    let parsed = parseDimensions(raw, defaultDim);
    if (parsed.dims.length === 0) {
      console.warn(`[static-eval] ${label} empty dims on attempt 1 (raw len=${raw.length}, head="${raw.slice(0, 80)}"), retrying`);
      const raw2 = await callLlm(client, model, prompt);
      parsed = parseDimensions(raw2, defaultDim);
      if (parsed.dims.length === 0) {
        console.warn(`[static-eval] ${label} still empty after retry (raw len=${raw2.length}, head="${raw2.slice(0, 80)}")`);
      }
    }
    return parsed;
  }

  function parsedToResult(parsed: { comment: string; dims: ParsedDim[] }, section: 'meta' | 'robustness' | 'security'): ChunkResult {
    const ds: Record<string, number> = {};
    for (const d of parsed.dims) if (d.score) ds[d.dimension] = d.score;
    return { comment: parsed.comment, dimensionScores: ds, issues: dimsToIssues(parsed.dims, section) };
  }

  const evalMeta = async (): Promise<ChunkResult> => {
    const prompt = PROMPT_SKILL_META.replace('${content}', args.skillContent);
    return parsedToResult(await callAndParse(prompt, 'SKILL.md', 'META'), 'meta');
  };

  const evalRobustness = async (chunk: string): Promise<ChunkResult> => {
    const prompt = PROMPT_ROBUSTNESS
      .replace('${skillContent}', args.skillContent)
      .replace('${bundleContent}', chunk);
    return parsedToResult(await callAndParse(prompt, '工程健壮性', 'ROBUSTNESS'), 'robustness');
  };

  const evalSecurity = async (chunk: string): Promise<ChunkResult> => {
    const prompt = PROMPT_SECURITY
      .replace('${skillContent}', args.skillContent)
      .replace('${bundleContent}', chunk);
    return parsedToResult(await callAndParse(prompt, '安全风险性', 'SECURITY'), 'security');
  };

  // 3 类并发：META 1 次；ROBUSTNESS / SECURITY 每 chunk 1 次
  // 用 Promise.allSettled 让单段失败不拖累其它段
  const settled = await Promise.allSettled([
    evalMeta(),
    Promise.all(effectiveChunks.map(evalRobustness)).then(mergeChunkResults),
    Promise.all(effectiveChunks.map(evalSecurity)).then(mergeChunkResults),
  ]);

  const [metaRes, robustnessRes, securityRes] = settled;
  const errors: string[] = [];

  if (metaRes.status === 'fulfilled') {
    overallComments.meta = metaRes.value.comment;
    Object.assign(dimensionScores, metaRes.value.dimensionScores);
    issues.push(...metaRes.value.issues);
  } else {
    errors.push(`META: ${String(metaRes.reason?.message || metaRes.reason)}`);
  }

  if (robustnessRes.status === 'fulfilled') {
    overallComments.robustness = robustnessRes.value.comment;
    Object.assign(dimensionScores, robustnessRes.value.dimensionScores);
    issues.push(...robustnessRes.value.issues);
  } else {
    errors.push(`ROBUSTNESS: ${String(robustnessRes.reason?.message || robustnessRes.reason)}`);
  }

  if (securityRes.status === 'fulfilled') {
    overallComments.security = securityRes.value.comment;
    Object.assign(dimensionScores, securityRes.value.dimensionScores);
    issues.push(...securityRes.value.issues);
  } else {
    errors.push(`SECURITY: ${String(securityRes.reason?.message || securityRes.reason)}`);
  }

  // 至少一段成功就算 ok；全失败才视为 LLM 评估失败
  if (Object.keys(dimensionScores).length === 0 && issues.length === 0 && errors.length > 0) {
    return {
      ok: false,
      errorMessage: `LLM 评估全部失败: ${errors.join('; ')}`,
      durationMs: Date.now() - startedAt,
      dimensionScores, overallComments, issues,
    };
  }

  return {
    ok: true,
    errorMessage: errors.length > 0 ? `部分阶段失败: ${errors.join('; ')}` : undefined,
    durationMs: Date.now() - startedAt,
    dimensionScores,
    overallComments,
    issues,
  };
}
