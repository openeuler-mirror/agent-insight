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
import { lintSkillContent, lintSecurity, type LinterDiagnosis } from './linter';
import { loadAssetBundle } from './content-loader';
import { runLlmStaticEvaluation, type LlmIssueDraft } from './llm-evaluator';

/**
 * Generator 版本号是 24h skip 与"重扫触发"的主键。
 * 2026-06 升级到 @0.2：6 维重组（替换运维可靠性 → 安全风险性；脚本质量 → 工程健壮性）
 * + L1 命中参与维度计分（L1_floor 与 L2 分数取 min）。
 * 升版本号会让所有历史 skill 在下一次 auto-upload 时自动重扫。
 */
export const STATIC_EVAL_GENERATOR_L1 = 'static-evaluator@0.2';
export const STATIC_EVAL_GENERATOR_L1_L2 = 'static-evaluator@0.2+llm';
const SKIP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * L1 命中转换为维度 floor 分数：
 *   high 命中   → 2 分（最严重）
 *   medium 命中 → 3 分
 *   low 命中    → 4 分
 *   无命中      → 5 分（不参与合并）
 * 每个 L1 维度取该维度命中的最低 floor（即最严重 severity）。
 */
const SEVERITY_TO_FLOOR: Record<Severity, number> = {
  high: 2,
  medium: 3,
  low: 4,
};

/** L1 linter 用英文枚举 dimension；这里映射回 L2 / UI 使用的中文维度名。 */
const L1_DIMENSION_TO_L2_NAME: Record<string, string> = {
  structure: '结构规范性',
  security: '安全风险性',
};

/**
 * 合并 L1 floor 和 L2 LLM 分数：
 *  - L1 命中的维度：finalScore = min(L1_floor, L2_score ?? 5)
 *  - L1 无命中的维度：保留 L2_score（若 L2 没跑则该维度仍为 notEvaluated）
 *
 * 这意味着 L2 没跑（用户没配 LLM / auto-upload 默认不跑 L2）时，
 * 只要 L1 命中了 structure / security 规则，相应维度仍有分。
 */
function mergeL1FloorWithL2Scores(
  diagnoses: LinterDiagnosis[],
  l2Scores: Record<string, number>,
): Record<string, number> {
  const l1Floor: Record<string, number> = {};
  for (const d of diagnoses) {
    const dimName = L1_DIMENSION_TO_L2_NAME[d.dimension];
    if (!dimName) continue;
    const floor = SEVERITY_TO_FLOOR[d.severity];
    if (l1Floor[dimName] === undefined || floor < l1Floor[dimName]) {
      l1Floor[dimName] = floor;
    }
  }

  const merged: Record<string, number> = { ...l2Scores };
  for (const [dim, floor] of Object.entries(l1Floor)) {
    const l2 = merged[dim];
    merged[dim] = l2 === undefined ? floor : Math.min(l2, floor);
  }
  return merged;
}

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
    // bundle 永远加载：
    //  - L1 security regex 用 bundleTextFull（不截断、不分批，本地扫描没 token 成本）
    //  - L2 LLM prompt 用 bundleChunks（按文件边界切分，大 bundle 自动 fan-out）
    const bundle = loadAssetBundle(skillVersion.assetPath);

    // L1 — 永远跑：structure（formal）+ security（threat regex），扫全量
    const linterDiagnoses: LinterDiagnosis[] = [
      ...lintSkillContent(content),
      ...lintSecurity(content, bundle.bundleTextFull),
    ];
    for (const d of linterDiagnoses) {
      issuesData.push(diagnosisToSkillIssueData(d, {
        evaluationId: evaluation.id,
        skillId: args.skillId,
        version: args.version,
        user: args.user,
      }));
    }

    let l2DimensionScores: Record<string, number> = {};
    let l2Comments: Record<string, string | undefined> = {};

    // L2 — 可选；3 stage 并发（chunking 在 runLlmStaticEvaluation 内部展开）
    if (enableL2) {
      const llm = await runLlmStaticEvaluation({
        user: args.user,
        skillContent: content,
        bundleChunks: bundle.bundleChunks,
      });

      if (llm.ok) {
        l2DimensionScores = llm.dimensionScores;
        l2Comments = llm.overallComments;
        for (const i of llm.issues) {
          issuesData.push(llmDraftToSkillIssueData(i, {
            evaluationId: evaluation.id,
            skillId: args.skillId,
            version: args.version,
            user: args.user,
          }));
        }
        // 部分 stage 失败仍算 ok，但要把 errorMessage 记录到 evaluation
        if (llm.errorMessage) {
          llmFailureMessage = llm.errorMessage;
        }
      } else {
        llmFailureMessage = llm.errorMessage || 'LLM 评估失败';
      }
    }

    // 合并 L1 floor 与 L2 LLM 分数。l2ScoresJson 字段名沿用，但语义已是"合并后的维度分数"。
    const mergedScores = mergeL1FloorWithL2Scores(linterDiagnoses, l2DimensionScores);
    if (Object.keys(mergedScores).length > 0) {
      l2ScoresJson = JSON.stringify({
        scores: mergedScores,
        comments: l2Comments,
      });
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
