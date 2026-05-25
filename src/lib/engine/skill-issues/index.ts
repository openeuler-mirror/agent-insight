/**
 * Skill 优化点聚合：从 SkillIssue + Evaluation 两张表读出 issues，
 * 跨 evaluation 按 dedupKey 去重 + 计 prevalence + 抬升 severity。
 *
 * 详细设计：docs/plans/2026-05-08-skill-opt-issues-api-design.md
 */

import { bumpSeverityByPrevalence, type Severity } from './prevalence';

export interface IssueWithPrevalence {
  id: string;
  evaluationId: string;
  source: 'static' | 'dynamic' | 'feedback';
  skillId: string;
  version: number;
  user: string | null;
  dedupKey: string;
  severity: Severity;
  summary: string;
  evidence: string | null;
  reasoning: string | null;
  suggestedFix: string | null;
  ruleId: string | null;
  dimension: string | null;
  category: string | null;
  resolvedAt: Date | null;
  resolvedRunId: string | null;
  createdAt: Date;
  prevalenceCount: number;          // 派生：同 dedupKey 在响应范围内被检出几次
  // 用于 API 层合成 source 跳转链接（OptIssue.source.url）
  evaluationType: 'static' | 'dynamic' | null;
  executionTaskId: string | null;
  evaluationRunId: string | null;
}

export interface AggregateStats {
  bySource: { static: number; dynamic: number; feedback: number };
  bySeverity: { high: number; medium: number; low: number };
  totalEvaluationsScanned: number;
}

export interface AggregateInput {
  prisma: any;                       // PrismaClient（用 any 避免类型循环）
  skillId: string;
  version?: number;                  // 不传 = 跨版本
  user: string | null;
  includeResolved?: boolean;         // 默认 false：只返回未解决的 issue
}

export interface AggregateResult {
  issues: IssueWithPrevalence[];
  stats: AggregateStats;
}

/**
 * 主聚合入口。两步：
 *   1. 一次 join 查出所有 (SkillIssue, Evaluation.ranAt) 行，按 user 多租户过滤
 *   2. JS 层按 dedupKey 分组 → 每组取最早一条作代表 + 累计 count
 *
 * 没用 raw SQL 是为了 schema 改动时类型还能跟住——Prisma 的 include + 排序在这点
 * 数据量下足够快。万一未来 SkillIssue 行数破万，再换 $queryRaw + window function。
 */
export async function aggregateSkillIssues(args: AggregateInput): Promise<AggregateResult> {
  const { prisma, skillId, version, user, includeResolved } = args;

  // 多租户：当前用户的 + null（公共）
  const userFilter = user
    ? { OR: [{ user }, { user: null }] }
    : {};   // 没登录时只取当前 query 的所有结果（NOT 推荐生产，开发期可用）

  const where: any = {
    skillId,
    ...userFilter,
  };
  if (typeof version === 'number') where.version = version;
  if (!includeResolved) where.resolvedAt = null;

  const rows = await prisma.skillIssue.findMany({
    where,
    include: {
      Evaluation: {
        select: {
          ranAt: true,
          type: true,
          runId: true,
          executionId: true,
          Execution: { select: { taskId: true } },
        },
      },
    },
    orderBy: [
      { dedupKey: 'asc' },
      { Evaluation: { ranAt: 'asc' } },
    ],
  });

  // 顺手统计这次 query 涉及多少条 Evaluation
  const evalIds = new Set<string>();
  for (const r of rows) evalIds.add(r.evaluationId);

  // 按 dedupKey 分组，每组第一条做代表
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byKey.get(r.dedupKey);
    if (arr) arr.push(r);
    else byKey.set(r.dedupKey, [r]);
  }

  const issues: IssueWithPrevalence[] = [];
  for (const group of byKey.values()) {
    const rep = group[0];
    const count = group.length;
    const sev = rep.severity as Severity;
    issues.push({
      id: rep.id,
      evaluationId: rep.evaluationId,
      source: rep.source as 'static' | 'dynamic' | 'feedback',
      skillId: rep.skillId,
      version: rep.version,
      user: rep.user,
      dedupKey: rep.dedupKey,
      severity: bumpSeverityByPrevalence(sev, count),
      summary: rep.summary,
      evidence: count > 1
        ? `${rep.evidence ?? ''}\n\n（来源：${count} 次评估检出）`.trim()
        : rep.evidence,
      reasoning: rep.reasoning,
      suggestedFix: rep.suggestedFix,
      ruleId: rep.ruleId,
      dimension: rep.dimension,
      category: rep.category ?? null,
      resolvedAt: rep.resolvedAt ?? null,
      resolvedRunId: rep.resolvedRunId ?? null,
      createdAt: rep.createdAt,
      prevalenceCount: count,
      evaluationType: (rep.Evaluation?.type as 'static' | 'dynamic') ?? null,
      executionTaskId: rep.Evaluation?.Execution?.taskId ?? null,
      evaluationRunId: rep.Evaluation?.runId ?? null,
    });
  }

  // 排序：severity（high → low），同档按 createdAt 倒序（最新的在前）
  const severityRank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => {
    const sevDiff = severityRank[a.severity] - severityRank[b.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.createdAt.getTime() - a.createdAt.getTime();
  });

  // stats
  const stats: AggregateStats = {
    bySource: { static: 0, dynamic: 0, feedback: 0 },
    bySeverity: { high: 0, medium: 0, low: 0 },
    totalEvaluationsScanned: evalIds.size,
  };
  for (const it of issues) {
    stats.bySource[it.source]++;
    stats.bySeverity[it.severity]++;
  }

  return { issues, stats };
}
