/**
 * L2 LLM 评估器：5 维 SKILL.md + 1 维 code/refs。
 * 调用用户配置的 LLM（复用 getActiveConfig + OpenAI 客户端）。
 *
 * 输出：
 *   - dimensionScores: { <dim>: 1-5 }，写到 Evaluation.l2ScoresJson
 *   - issues: 拍平后的 SkillIssue 雏形列表
 */

import { OpenAI } from 'openai';
import { createHash } from 'crypto';

import { getActiveConfig } from '@/lib/storage/server-config';
import { getProxyConfig } from '@/lib/ingest/proxy-config';
import type { Severity } from '../prevalence';
import { PROMPT_SKILL_META, PROMPT_CODE_QUALITY } from './prompts';

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
  overallComments: { meta?: string; code?: string };
  issues: LlmIssueDraft[];
}

const TIMEOUT_MS = Number(process.env.STATIC_EVAL_LLM_TIMEOUT_MS || 120_000);

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

function tryParseJson(text: string): unknown {
  let s = (text || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) s = fenced[1].trim();
  if (!s.startsWith('{')) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b > a) s = s.slice(a, b + 1);
  }
  return JSON.parse(s);
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
      },
      { signal: controller.signal },
    );
    return resp.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

// 调用 + 解析，若拿不到任何维度评分（空 content / 非法 JSON / 缺 detailed_evaluation）
// 则重试一次。推理类模型（如 deepseek-reasoner）偶发返回空或截断输出，重试基本能恢复。
async function callAndParse(
  client: OpenAI,
  model: string,
  prompt: string,
  defaultDimensionName: string,
): Promise<{ comment: string; dims: ParsedDim[] }> {
  let last: { comment: string; dims: ParsedDim[] } = { comment: '', dims: [] };
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callLlm(client, model, prompt);
    const parsed = parseDimensions(raw, defaultDimensionName);
    last = parsed;
    if (parsed.dims.some((d) => d.score > 0)) return parsed;
  }
  return last;
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
  let parsed: unknown;
  try {
    parsed = tryParseJson(raw);
  } catch {
    return { comment: '', dims: [] };
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const comment = typeof root.overall_comment === 'string' ? root.overall_comment : '';
  const detail = Array.isArray(root.detailed_evaluation) ? root.detailed_evaluation : [];
  const dims: ParsedDim[] = detail.map((entry: unknown) => {
    const d = (entry ?? {}) as Record<string, unknown>;
    const rawIssues = Array.isArray(d.issues) ? d.issues : [];
    return {
      dimension: typeof d.dimension === 'string' ? d.dimension : defaultDimensionName,
      score: Number(d.score) || 0,
      justification: typeof d.justification === 'string' ? d.justification : '',
      issues: rawIssues
        .map((ri: unknown) => (ri ?? {}) as Record<string, unknown>)
        .filter((i) => typeof i.summary === 'string' && i.summary.trim())
        .map((i) => ({
          summary: String(i.summary),
          severity: typeof i.severity === 'string' ? i.severity : undefined,
          evidence: typeof i.evidence === 'string' ? i.evidence : undefined,
          suggestedFix: typeof i.suggestedFix === 'string' ? i.suggestedFix : undefined,
        })),
    };
  });
  return { comment, dims };
}

function dimsToIssues(dims: ParsedDim[], section: 'meta' | 'code'): LlmIssueDraft[] {
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

export async function runLlmStaticEvaluation(args: {
  user?: string | null;
  skillContent: string;        // SKILL.md 全文
  bundleContent: string;       // references + scripts 拼接
}): Promise<LlmEvalOutcome> {
  const startedAt = Date.now();
  const dimensionScores: Record<string, number> = {};
  const overallComments: { meta?: string; code?: string } = {};
  const issues: LlmIssueDraft[] = [];

  try {
    const config = await getActiveConfig(args.user);
    if (!config) {
      return {
        ok: false,
        errorMessage: '未配置可用的 LLM。请到「配置」页设置评估模型。',
        durationMs: Date.now() - startedAt,
        dimensionScores,
        overallComments,
        issues,
      };
    }

    const { customFetch } = getProxyConfig();
    const client = new OpenAI({
      apiKey: config.apiKey || 'no-api-key-required',
      baseURL: config.baseUrl || 'https://api.deepseek.com',
      fetch: customFetch as typeof fetch | undefined,
    });
    const model = config.model || 'deepseek-chat';

    // 阶段 1：SKILL.md 五维评估
    const metaPrompt = PROMPT_SKILL_META.replace('${content}', args.skillContent);
    const metaParsed = await callAndParse(client, model, metaPrompt, 'SKILL.md');
    overallComments.meta = metaParsed.comment;
    for (const d of metaParsed.dims) {
      if (d.score) dimensionScores[d.dimension] = d.score;
    }
    issues.push(...dimsToIssues(metaParsed.dims, 'meta'));

    // 阶段 2：参考实现 / 脚本质量（仅在有内容时跑）
    if (args.bundleContent.trim()) {
      const codePrompt = PROMPT_CODE_QUALITY.replace('${content}', args.bundleContent);
      const codeParsed = await callAndParse(client, model, codePrompt, '脚本及参考文档质量');
      overallComments.code = codeParsed.comment;
      for (const d of codeParsed.dims) {
        if (d.score) dimensionScores[d.dimension] = d.score;
      }
      issues.push(...dimsToIssues(codeParsed.dims, 'code'));
    }

    // 重试后仍拿不到任何维度评分：判定 L2 失败并给出用户可读原因，
    // 而不是静默地以 ok 收尾（那样会在前端显示"维度评分缺失"的内部文案）。
    if (Object.keys(dimensionScores).length === 0) {
      return {
        ok: false,
        errorMessage: '评估模型未返回可解析的维度评分（已自动重试 1 次）。请稍后点击「重新分析」重试，或在「配置」页更换评估模型。',
        durationMs: Date.now() - startedAt,
        dimensionScores,
        overallComments,
        issues,
      };
    }

    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      dimensionScores,
      overallComments,
      issues,
    };
  } catch (e) {
    const msg = e instanceof Error && e.name === 'AbortError'
      ? `LLM 调用超时（${TIMEOUT_MS}ms）`
      : (e instanceof Error ? e.message : String(e));
    return {
      ok: false,
      errorMessage: msg,
      durationMs: Date.now() - startedAt,
      dimensionScores,
      overallComments,
      issues,
    };
  }
}
