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

function tryParseJson(text: string): any {
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
  } catch (e) {
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
      fetch: customFetch as any,
    });
    const model = config.model || 'deepseek-chat';

    // 阶段 1：SKILL.md 五维评估
    const metaPrompt = PROMPT_SKILL_META.replace('${content}', args.skillContent);
    const metaRaw = await callLlm(client, model, metaPrompt);
    const metaParsed = parseDimensions(metaRaw, 'SKILL.md');
    overallComments.meta = metaParsed.comment;
    for (const d of metaParsed.dims) {
      if (d.score) dimensionScores[d.dimension] = d.score;
    }
    issues.push(...dimsToIssues(metaParsed.dims, 'meta'));

    // 阶段 2：参考实现 / 脚本质量（仅在有内容时跑）
    if (args.bundleContent.trim()) {
      const codePrompt = PROMPT_CODE_QUALITY.replace('${content}', args.bundleContent);
      const codeRaw = await callLlm(client, model, codePrompt);
      const codeParsed = parseDimensions(codeRaw, '脚本及参考文档质量');
      overallComments.code = codeParsed.comment;
      for (const d of codeParsed.dims) {
        if (d.score) dimensionScores[d.dimension] = d.score;
      }
      issues.push(...dimsToIssues(codeParsed.dims, 'code'));
    }

    return {
      ok: true,
      durationMs: Date.now() - startedAt,
      dimensionScores,
      overallComments,
      issues,
    };
  } catch (e: any) {
    const msg = e?.name === 'AbortError' ? `LLM 调用超时（${TIMEOUT_MS}ms）` : String(e?.message || e);
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
