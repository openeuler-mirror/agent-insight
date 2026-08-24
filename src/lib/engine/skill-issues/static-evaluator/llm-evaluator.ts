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

/**
 * 评分采样温度。实测：不设 temperature 时走 provider 默认（DeepSeek ≈1.0），
 * 同一份 SKILL.md 的维度分会在 1-5 间剧烈抖动（尤以「指令适配性」为甚），
 * 单次抽样跨版本对比会造出"优化后分数下降"的假象。固定为 0 大幅压缩方差。
 */
const TEMPERATURE = Number(process.env.STATIC_EVAL_TEMPERATURE ?? 0);

/**
 * 每个评估阶段的采样次数：跑 SAMPLES 次取「每维度中位数」。
 * 动机：temperature=0 对 DeepSeek 仍非完全确定（偶有离群分），且会出现偶发假阴性
 * （如把完整脚本判为"核心脚本不完整→1"）。多采样取中位数把离群值投票掉，让分数可复现。
 * 代价：LLM 调用数 ×SAMPLES（静态评估低频，可接受）；设 1 即退回单次行为。
 */
const SAMPLES = Math.max(1, Number(process.env.STATIC_EVAL_SAMPLES || 3));

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
        temperature: TEMPERATURE,
      },
      { signal: controller.signal },
    );
    return resp.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

export interface ParsedDim {
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

function dimensionCompleteness(dimension: ParsedDim): number {
  const validScore = dimension.score >= 1 && dimension.score <= 5 ? 10_000 : 0;
  const supportedIssues = dimension.issues.reduce((total, issue) => (
    total
    + (issue.evidence?.trim().length || 0)
    + (issue.suggestedFix?.trim().length || 0)
  ), 0);
  return validScore + dimension.justification.trim().length + supportedIssues;
}

export function normalizeLlmDimensions(rawDimensions: unknown[], defaultDimensionName: string): ParsedDim[] {
  const normalized = rawDimensions.map((raw) => {
    const d = raw as Record<string, unknown>;
    const rawScore = Number(d?.score);
    const score = Number.isFinite(rawScore) && rawScore >= 1 && rawScore <= 5 ? rawScore : 0;
    return {
      dimension: typeof d?.dimension === 'string' && d.dimension.trim()
        ? d.dimension.trim()
        : defaultDimensionName,
      score,
      justification: typeof d?.justification === 'string' ? d.justification.trim() : '',
      issues: Array.isArray(d?.issues)
        ? d.issues
            .filter((issue: unknown) => {
              const item = issue as Record<string, unknown>;
              return typeof item?.summary === 'string' && item.summary.trim();
            })
            .map((issue: unknown) => {
              const item = issue as Record<string, unknown>;
              return {
                summary: String(item.summary).trim(),
                severity: typeof item?.severity === 'string' ? item.severity : undefined,
                evidence: typeof item?.evidence === 'string' ? item.evidence.trim() : undefined,
                suggestedFix: typeof item?.suggestedFix === 'string' ? item.suggestedFix.trim() : undefined,
              };
            })
        : [],
    } satisfies ParsedDim;
  });

  const byDimension = new Map<string, ParsedDim>();
  for (const dimension of normalized) {
    if (dimension.score === 0 && dimension.issues.length === 0) continue;
    const existing = byDimension.get(dimension.dimension);
    if (!existing || dimensionCompleteness(dimension) > dimensionCompleteness(existing)) {
      byDimension.set(dimension.dimension, dimension);
    }
  }
  return [...byDimension.values()];
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
  const dims = normalizeLlmDimensions(detail, defaultDimensionName);
  return { comment, dims };
}

export function llmDimensionsToIssues(dims: ParsedDim[], section: 'meta' | 'robustness' | 'security'): LlmIssueDraft[] {
  const out: LlmIssueDraft[] = [];
  for (const d of dims) {
    const validScore = d.score >= 1 && d.score <= 5;
    const fallbackSev = validScore ? severityFromScore(d.score) : null;
    if (!validScore && d.issues.length === 0) continue;
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
      const requestedSeverity = normalizeSeverity(it.severity, fallbackSev || 'medium');
      const supported = Boolean(it.evidence?.trim() || d.justification.trim());
      const sev = requestedSeverity === 'high' && !supported ? 'medium' : requestedSeverity;
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

/** 下中位数（偶数个取偏低者），确定性、对离群值鲁棒。整数评分场景下稳定。 */
function lowerMedian(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * 把同一阶段的 SAMPLES 次采样聚合成一个结果：
 *   - 每个维度的分数取所有采样的「中位数」（投票掉离群的高/低分与偶发假阴性）
 *   - 该维度的 issues / justification 取「分数等于中位数」的那次采样（与上报分自洽）
 *   - comment 取首个非空代表采样
 * 注意：用中位数而非 mergeChunkResults 的 min——min 会把"不幸的低抽样"重新放大，正是要消除的噪声。
 */
function aggregateSamples(results: ChunkResult[]): ChunkResult {
  if (results.length === 0) return { comment: '', dimensionScores: {}, issues: [] };
  if (results.length === 1) return results[0];

  const allDims = new Set<string>();
  for (const r of results) for (const d of Object.keys(r.dimensionScores)) allDims.add(d);

  const dimensionScores: Record<string, number> = {};
  const issues: LlmIssueDraft[] = [];
  let comment = '';

  for (const dim of allDims) {
    const scored = results.filter(r => typeof r.dimensionScores[dim] === 'number');
    if (scored.length === 0) continue;
    const med = lowerMedian(scored.map(r => r.dimensionScores[dim]));
    dimensionScores[dim] = med;
    // 代表采样：分数命中中位数的第一条；其 issues 才与上报分自洽
    const rep = scored.find(r => r.dimensionScores[dim] === med) || scored[0];
    issues.push(...rep.issues.filter(i => i.dimension === dim));
    if (!comment && rep.comment) comment = rep.comment;
  }
  return { comment, dimensionScores, issues };
}

/** 跑某阶段 SAMPLES 次并按中位数聚合；单次失败不拖累其它采样，全失败才抛错。 */
async function sampleStage(fn: () => Promise<ChunkResult>, k: number): Promise<ChunkResult> {
  if (k <= 1) return fn();
  const settled = await Promise.allSettled(Array.from({ length: k }, () => fn()));
  const ok = settled
    .filter((s): s is PromiseFulfilledResult<ChunkResult> => s.status === 'fulfilled')
    .map(s => s.value);
  if (ok.length === 0) {
    const firstErr = settled.find(s => s.status === 'rejected') as PromiseRejectedResult | undefined;
    throw firstErr?.reason ?? new Error('all samples failed');
  }
  return aggregateSamples(ok);
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
    defaultHeaders: config.headers,
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
    return { comment: parsed.comment, dimensionScores: ds, issues: llmDimensionsToIssues(parsed.dims, section) };
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

  // 3 类并发：每类各跑 SAMPLES 次取中位数去噪。
  // META 每次 1 调用；ROBUSTNESS / SECURITY 每次按 chunk fan-out 后 mergeChunkResults。
  // 用 Promise.allSettled 让单段失败不拖累其它段。
  const settled = await Promise.allSettled([
    sampleStage(evalMeta, SAMPLES),
    sampleStage(() => Promise.all(effectiveChunks.map(evalRobustness)).then(mergeChunkResults), SAMPLES),
    sampleStage(() => Promise.all(effectiveChunks.map(evalSecurity)).then(mergeChunkResults), SAMPLES),
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
