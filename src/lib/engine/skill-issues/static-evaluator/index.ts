/**
 * 静态评估器 orchestrator。
 *
 * 写入分工见 docs/plans/2026-05-08-skill-opt-issues-api-design.md：
 *   - 创建 Evaluation(type='static') 一行
 *   - 把 L1 linter + L2 LLM 的产出统一转成 SkillIssue 行（source='static'，FK = evaluation.id）
 *
 * 触发：
 *   - 自动：skill 上传 / 存新版本 / skill-opt 采纳后 fire-and-forget；
 *     24h 内同 contentHash + 同 generator 的 ok 评估存在则跳过
 *   - 手动：UI 上「重新评估」按钮，不走 24h skip
 *
 * 模型门控：未配置评估模型时，自动/手动一律直接 skip、不创建 Evaluation 行——
 * 评估必须是完整 L1+L2 流程，不允许单独跑 L1。L1 不单独评分：维度分数只在
 * L2（LLM）跑成功后产出（L1 命中作为 floor 与 L2 分取 min）；L2 中途失败时只落
 * issue 列表，不落任何分数，避免 UI 把纯 L1 floor 当完整评分展示、误导用户。
 *
 * 重评懒删除：每次跑都新建 Evaluation 行，旧的不删；前端按 ranAt DESC 取最近一条做概述。
 */

import { createHash } from 'crypto';

import { prismaRaw } from '@/lib/storage/prisma';
import { getActiveConfig } from '@/lib/storage/server-config';
import type { Severity } from '../prevalence';
import { lintSkillContent, lintSecurity, type LinterDiagnosis } from './linter';
import { loadAssetBundle } from './content-loader';
import { runLlmStaticEvaluation, type LlmIssueDraft } from './llm-evaluator';

/**
 * Generator 版本号是 24h skip 与"重扫触发"的主键。
 * 2026-06 升级到 @0.2：6 维重组（替换运维可靠性 → 安全风险性；脚本质量 → 工程健壮性）
 * + L1 命中参与维度计分（L1_floor 与 L2 分数取 min）。
 * 升版本号会让所有历史 skill 在下一次 auto-upload 时自动重扫。
 *
 * 评估一律 L1+L2；不带 +llm 后缀的纯 L1 generator（@0.1 / @0.2）只存在于历史数据。
 */
export const STATIC_EVAL_GENERATOR_L1_L2 = 'static-evaluator@0.2+llm';
const SKIP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 维度分数只在 LLM 参与的完整评估（generator 带 +llm 后缀，含历史 @0.1+llm）里有效。
 * 纯 L1 generator 的历史行可能在 l2ScoresJson 里残留 L1 floor 分数——L1 不单独评分，
 * 序列化层用本判断把这些分数挡在前端之外。
 */
export function isLlmScoredGenerator(generator: string | null | undefined): boolean {
  return !!generator && generator.includes('+llm');
}

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
 *  - L1 无命中的维度：保留 L2_score（L2 没评到的维度仍为 notEvaluated）
 *
 * 仅在 L2 跑成功后调用——L1 不单独评分，纯 L1 的命中只产出 issue，不产出分数。
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

/**
 * 从 SkillVersion.files（JSON 字符串数组的相对路径清单）数出 references/ 与 scripts/ 下的附件数。
 * 只数这两个子目录——这正是 loadAssetBundle 实际会读取的范围（见 content-loader）。
 * 用来判断「清单说有附件、但磁盘 bundle 一个都没读到」的不一致（防御性硬失败用）。
 */
function countExpectedBundleFiles(filesJson: string | null | undefined): number {
  if (!filesJson) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(filesJson);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  return parsed.filter(
    (p) => typeof p === 'string' && /^(references|scripts)\//.test(p),
  ).length;
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

  // 模型门控：评估必须有 LLM 参与（L1 不单独评分），未配模型一律不跑、不创建 Evaluation 行。
  const config = await getActiveConfig(args.user);
  if (!config) {
    return {
      status: 'skipped',
      issuesCount: 0,
      skipReason: '未配置评估模型，跳过评估',
    };
  }

  const skillVersion = await prismaRaw.skillVersion.findUnique({
    where: { skillId_version: { skillId: args.skillId, version: args.version } },
  });
  if (!skillVersion) {
    return { status: 'failed', issuesCount: 0, errorMessage: 'SkillVersion not found' };
  }

  const content = skillVersion.content ?? '';
  const contentHash = computeContentHash(content);
  const generator = STATIC_EVAL_GENERATOR_L1_L2;

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

    // 防御性硬失败：清单（SkillVersion.files）声明了 references/scripts 附件，但磁盘上一个都没读到。
    // 成因：loadAssetBundle 用 path.resolve(assetPath)（相对 process.cwd()）解析存储目录，
    // 当运行 cwd ≠ 存储根（如 git worktree 里跑、或部署布局把 cwd 与 data/ 分离）时 bundle 解析为空。
    // 若放任不管，ROBUSTNESS / SECURITY 两个 L2 阶段会被喂空 bundle 盲评，
    // 稳定误判成「缺少所有参考脚本 / 核心脚本不完整 → 工程健壮性=1」这类假阴性。
    // 宁可显式失败也不盲评：抛错由下方 catch 统一记为 failed + 写 errorMessage 便于诊断。
    const expectedBundleFiles = countExpectedBundleFiles(skillVersion.files);
    if (expectedBundleFiles > 0 && bundle.fileCount === 0) {
      throw new Error(
        `资产 bundle 加载为空，但 SkillVersion.files 声明了 ${expectedBundleFiles} 个 references/scripts 附件` +
          `（assetPath=${skillVersion.assetPath ?? 'null'}，cwd=${process.cwd()}）。` +
          `多半是运行工作目录与存储根不一致（如在 git worktree 内运行）。` +
          `已中止评估以避免对工程健壮性/安全风险性盲评出假阴性；请从存储根目录运行，或修正 assetPath / 存储路径。`,
      );
    }

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
    let l2Ok = false;

    // L2 — 3 stage 并发（chunking 在 runLlmStaticEvaluation 内部展开）；
    // 未配模型 / 全 stage 失败时 llm.ok = false，评估记为 partial。
    const llm = await runLlmStaticEvaluation({
      user: args.user,
      skillContent: content,
      bundleChunks: bundle.bundleChunks,
    });

    if (llm.ok) {
      l2Ok = true;
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

    // 合并 L1 floor 与 L2 LLM 分数。l2ScoresJson 字段名沿用，但语义已是"合并后的维度分数"。
    // L1 不单独评分：L2 没跑成功时不落任何分数，只留 issue 列表。
    if (l2Ok) {
      const mergedScores = mergeL1FloorWithL2Scores(linterDiagnoses, l2DimensionScores);
      if (Object.keys(mergedScores).length > 0) {
        l2ScoresJson = JSON.stringify({
          scores: mergedScores,
          comments: l2Comments,
        });
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
