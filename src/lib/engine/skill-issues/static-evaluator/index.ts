/**
 * 静态评估器 orchestrator。
 *
 * 写入分工见 docs/plans/2026-05-08-skill-opt-issues-api-design.md：
 *   - 创建 Evaluation(type='static') 一行
 *   - 把 L1 linter + L2 LLM 的产出统一转成 SkillIssue 行（source='static'，FK = evaluation.id）
 *
 * 触发：
 *   - 自动：skill 上传后 fire-and-forget；24h 内同 contentHash + 同 generator 的 ok 评估存在则跳过
 *   - 手动：UI 上「重新评估」按钮，永远跑（不 skip）
 *
 * 重评懒删除：每次跑都新建 Evaluation 行，旧的不删；前端按 ranAt DESC 取最近一条做概述。
 */

import { createHash } from 'crypto';

import { prismaRaw } from '@/lib/storage/prisma';
import type { Severity } from '../prevalence';
import { lintSkillContent, type LinterDiagnosis } from './linter';
import { loadAssetBundle } from './content-loader';
import { runLlmStaticEvaluation, type LlmIssueDraft } from './llm-evaluator';

export const STATIC_EVAL_GENERATOR_L1 = 'static-evaluator@0.1';
export const STATIC_EVAL_GENERATOR_L1_L2 = 'static-evaluator@0.1+llm';
const SKIP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RunArgs {
  skillId: string;
  version: number;
  user: string | null;
  trigger: 'manual' | 'auto-upload';
  enableL2?: boolean;        // 默认：manual=true（如可用）/ auto=false
}

export interface RunResult {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  evaluationId?: string;
  skipReason?: string;
  issuesCount: number;
  errorMessage?: string;
}

function computeContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

interface SkillIssueRow {
  evaluationId: string;
  source: string;
  skillId: string;
  version: number;
  user: string | null;
  dedupKey: string;
  severity: Severity;
  summary: string;
  evidence: string | null;
  reasoning: string | null;
  suggestedFix: string | null;
  ruleId: string;
  dimension: string;
}

function diagnosisToSkillIssueData(
  d: LinterDiagnosis,
  shared: { evaluationId: string; skillId: string; version: number; user: string | null },
): SkillIssueRow {
  return {
    evaluationId: shared.evaluationId,
    source: 'static',
    skillId: shared.skillId,
    version: shared.version,
    user: shared.user,
    dedupKey: d.ruleId,
    severity: d.severity,
    summary: d.summary,
    evidence: d.evidence ?? null,
    reasoning: d.reasoning ?? null,
    suggestedFix: d.suggestedFix ?? null,
    ruleId: d.ruleId,
    dimension: d.dimension,
  };
}

function llmDraftToSkillIssueData(
  i: LlmIssueDraft,
  shared: { evaluationId: string; skillId: string; version: number; user: string | null },
): SkillIssueRow {
  return {
    evaluationId: shared.evaluationId,
    source: 'static',
    skillId: shared.skillId,
    version: shared.version,
    user: shared.user,
    dedupKey: i.ruleId,
    severity: i.severity as Severity,
    summary: i.summary,
    evidence: i.evidence ?? null,
    reasoning: i.reasoning ?? null,
    suggestedFix: i.suggestedFix ?? null,
    ruleId: i.ruleId,
    dimension: i.dimension,
  };
}

/**
 * 主入口。同步等待整个流程完成，由调用方决定是否 await（自动触发应 fire-and-forget）。
 */
export async function runStaticEvaluation(args: RunArgs): Promise<RunResult> {
  const startedAt = Date.now();
  const skillVersion = await prismaRaw.skillVersion.findUnique({
    where: { skillId_version: { skillId: args.skillId, version: args.version } },
  });
  if (!skillVersion) {
    return { status: 'failed', issuesCount: 0, errorMessage: 'SkillVersion not found' };
  }

  const content = skillVersion.content ?? '';
  const contentHash = computeContentHash(content);
  const enableL2 = args.enableL2 ?? args.trigger === 'manual';
  const generator = enableL2 ? STATIC_EVAL_GENERATOR_L1_L2 : STATIC_EVAL_GENERATOR_L1;

  if (args.trigger === 'auto-upload') {
    const skipCutoff = new Date(Date.now() - SKIP_WINDOW_MS);
    const recent = await prismaRaw.evaluation.findFirst({
      where: {
        skillId: args.skillId,
        version: args.version,
        type: 'static',
        contentHash,
        generator,
        status: 'ok',
        ranAt: { gte: skipCutoff },
      },
      select: { id: true, ranAt: true },
    });
    if (recent) {
      return {
        status: 'skipped',
        evaluationId: recent.id,
        issuesCount: 0,
        skipReason: `24h 内已有同 contentHash + ${generator} 的成功评估`,
      };
    }
  }

  const evaluation = await prismaRaw.evaluation.create({
    data: {
      type: 'static',
      skillId: args.skillId,
      version: args.version,
      user: args.user,
      contentHash,
      generator,
      status: 'pending',
    },
  });

  const issuesData: SkillIssueRow[] = [];

  let l2ScoresJson: string | null = null;
  let llmFailureMessage: string | null = null;

  try {
    // L1 — 永远跑
    const linterDiagnoses = lintSkillContent(content);
    for (const d of linterDiagnoses) {
      issuesData.push(diagnosisToSkillIssueData(d, {
        evaluationId: evaluation.id,
        skillId: args.skillId,
        version: args.version,
        user: args.user,
      }));
    }

    // L2 — 可选
    if (enableL2) {
      const bundle = loadAssetBundle(skillVersion.assetPath);
      const llm = await runLlmStaticEvaluation({
        user: args.user,
        skillContent: content,
        bundleContent: [bundle.references, bundle.scripts].filter(Boolean).join('\n\n'),
      });

      if (llm.ok) {
        if (Object.keys(llm.dimensionScores).length > 0) {
          l2ScoresJson = JSON.stringify({
            scores: llm.dimensionScores,
            comments: llm.overallComments,
          });
        }
        for (const i of llm.issues) {
          issuesData.push(llmDraftToSkillIssueData(i, {
            evaluationId: evaluation.id,
            skillId: args.skillId,
            version: args.version,
            user: args.user,
          }));
        }
      } else {
        llmFailureMessage = llm.errorMessage || 'LLM 评估失败';
      }
    }

    if (issuesData.length > 0) {
      await prismaRaw.skillIssue.createMany({ data: issuesData });
    }

    const finalStatus: 'ok' | 'partial' = llmFailureMessage ? 'partial' : 'ok';
    await prismaRaw.evaluation.update({
      where: { id: evaluation.id },
      data: {
        status: finalStatus,
        durationMs: Date.now() - startedAt,
        l2ScoresJson,
        errorMessage: llmFailureMessage,
      },
    });

    return {
      status: finalStatus,
      evaluationId: evaluation.id,
      issuesCount: issuesData.length,
      errorMessage: llmFailureMessage ?? undefined,
    };
  } catch (e: any) {
    const msg = String(e?.message || e);
    await prismaRaw.evaluation.update({
      where: { id: evaluation.id },
      data: {
        status: 'failed',
        durationMs: Date.now() - startedAt,
        errorMessage: msg,
      },
    }).catch(() => undefined);
    return {
      status: 'failed',
      evaluationId: evaluation.id,
      issuesCount: 0,
      errorMessage: msg,
    };
  }
}
