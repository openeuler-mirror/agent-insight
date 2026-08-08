/**
 * 优化计划（归并算子）API。
 *
 * POST /api/skill-opt/plan  （异步）
 *   body: { user, skillName, baseVersion, sessionId, coreBudget?, batchSize? }
 *   立刻建一条 status=running 的空 plan 返回；归并（多轮 LLM，240 点可达数分钟）在后台
 *   fire-and-forget 跑，落库后置 status=draft，失败置 failed。HTTP 不再一直挂着。
 *   幂等：同 sessionId 已有非终态 plan（running/draft/…）直接返回；failed 或卡死的 running 删旧重跑。
 *
 * GET /api/skill-opt/plan?sessionId=...&user=...
 *   返回该会话的 plan + items（无则 { plan: null }）。前端据 plan.status 轮询到非 running 为止。
 *
 * SkillIssue 台账只读不写；resolve 回标发生在 iteration 落库时（见 iterations 路由）。
 * 设计：docs/plans/2026-06-10-skill-issue-merge-conflict-plan-design.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, prismaRaw } from '@/lib/storage/prisma';
import { resolveUser, canAccessSkill } from '@/lib/auth/auth';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import { getActiveConfig, getUserSettings } from '@/lib/storage/server-config';
import { aggregateSkillIssues } from '@/lib/engine/skill-issues';
import { runMergeOperator, type MergeIssueInput } from '@/lib/engine/skill-opt/merge-operator';
import { loadSkillVersionSnapshot } from '@/lib/engine/skill-opt/version-snapshot';

export const dynamic = 'force-dynamic';

// running 状态的 plan 超过这个时长仍没收尾，视作"进程中途挂了"的僵尸，允许重跑。
const STALE_RUNNING_MS = 10 * 60 * 1000;

/**
 * 后台跑归并算子：runMergeOperator（多轮 LLM，240 点可达几十秒～数分钟）→ 把 items 落库、
 * status 置 draft。任何失败都落进 plan.status=failed + operatorMeta.error，绝不向外抛——
 * 由 POST 以 fire-and-forget 调起（void + .catch），app 是长驻 node 进程，响应返回后这个
 * promise 继续跑到 update。前端据 GET /plan?sessionId 轮询 status 直到不再是 running。
 */
async function executeMergeOperator(args: {
  planId: string;
  skillName: string;
  baseVersion: number;
  issues: MergeIssueInput[];
  files: Record<string, string>;
  config: Parameters<typeof runMergeOperator>[0]['config'];
  coreBudget?: number;
  batchSize?: number;
}): Promise<void> {
  try {
    const result = await runMergeOperator({
      skillName: args.skillName,
      baseVersion: args.baseVersion,
      issues: args.issues,
      files: args.files,
      config: args.config,
      coreBudget: args.coreBudget,
      batchSize: args.batchSize,
    });
    await (prismaRaw as any).skillOptPlan.update({
      where: { id: args.planId },
      data: {
        status: 'draft',
        operatorMeta: JSON.stringify(result.meta),
        items: {
          create: result.items.map((it) => ({
            rank: it.rank,
            route: it.route,
            status: it.status,
            title: it.title,
            rationale: it.rationale,
            severity: it.severity,
            targetFile: it.targetFile,
            anchorText: it.anchorText,
            proposedEdit: it.proposedEdit,
            conflictNote: it.conflictNote,
            sourceIssueIds: JSON.stringify(it.sourceIssueIds),
            sourcesBreakdown: JSON.stringify(it.sourcesBreakdown),
            prevalence: it.prevalence,
          })),
        },
      },
    });
  } catch (err: any) {
    console.error('[skill-opt plan] background merge failed:', err?.message || err);
    await (prismaRaw as any).skillOptPlan
      .update({
        where: { id: args.planId },
        data: { status: 'failed', operatorMeta: JSON.stringify({ error: String(err?.message || err) }) },
      })
      .catch(() => {/* plan 可能已被删/重建，吞掉 */});
  }
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const skillName = String(body?.skillName || '').trim();
  const sessionId = String(body?.sessionId || '').trim();
  const baseVersion = body?.baseVersion;
  const { username: user } = await resolveUser(req, typeof body?.user === 'string' ? body.user : null);

  const missing: string[] = [];
  if (!user) missing.push('user');
  if (!skillName) missing.push('skillName');
  if (!sessionId) missing.push('sessionId');
  if (!Number.isInteger(baseVersion)) missing.push('baseVersion');
  if (missing.length > 0) {
    return NextResponse.json({ error: `Missing fields: ${missing.join(', ')}` }, { status: 400 });
  }

  try {
    // 幂等：该会话已有 plan 直接返回（running/draft/confirmed/… 原样回，前端据 status 决定是否轮询）。
    // 例外：failed 或"卡死的 running"（超 STALE_RUNNING_MS 没收尾，多半进程中途挂了）→ 删旧重跑。
    const existing = await (prismaRaw as any).skillOptPlan.findUnique({
      where: { sessionId },
      include: { items: { orderBy: { rank: 'asc' } } },
    });
    if (existing) {
      const staleRunning =
        existing.status === 'running' &&
        Date.now() - new Date(existing.createdAt).getTime() > STALE_RUNNING_MS;
      if (existing.status === 'failed' || staleRunning) {
        await (prismaRaw as any).skillOptPlan.delete({ where: { id: existing.id } }).catch(() => {});
      } else {
        return NextResponse.json({ plan: serializePlan(existing), reused: true });
      }
    }

    // session 必须存在且 skill/version 对得上（防串会话写 plan）
    const session = await (prismaRaw as any).skillOptSession.findUnique({
      where: { id: sessionId },
      select: { id: true, skillName: true, baseVersion: true },
    });
    if (!session) return NextResponse.json({ error: 'session not found' }, { status: 404 });
    if (session.skillName !== skillName || session.baseVersion !== baseVersion) {
      return NextResponse.json({ error: 'session skill/version mismatch' }, { status: 400 });
    }

    // 找 skill + 鉴权（与 optimization-points 路由同款）
    const where: any = { name: skillName, OR: [{ user }, { user: null }, { visibility: 'public' }] };
    const skills = await db.findSkills(where);
    const skill = skills[0];
    if (!skill) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    const { allowed } = await canAccessSkill(skill.id, user);
    if (!allowed) return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });

    // 模型配置：body.modelId 显式指定优化器模型（与"测量模型"解耦，便于对照实验）；
    // 不传则回退 active config。没配模型直接拦（与静态评估同款约束）。
    const modelId = typeof body?.modelId === 'string' ? body.modelId.trim() : '';
    let config = null;
    if (modelId) {
      const settings = await getUserSettings(user);
      config = settings.configs.find(c => c.id === modelId) || null;
    }
    if (!config) config = await getActiveConfig(user);
    if (!config) {
      return NextResponse.json({ error: '未配置可用的 LLM，请先到「配置」页设置模型' }, { status: 400 });
    }

    // 聚合未解决 issues
    const agg = await aggregateSkillIssues({
      prisma: prismaRaw as any,
      skillId: skill.id,
      version: baseVersion,
      user,
      includeResolved: false,
    });
    if (agg.issues.length === 0) {
      return NextResponse.json({ plan: null, reason: 'no unresolved issues' });
    }

    // baseVersion 文件快照（锚点校验 + prompt 上下文）
    const versionRow = await (prismaRaw as any).skillVersion.findUnique({
      where: { skillId_version: { skillId: skill.id, version: baseVersion } },
      select: { content: true, files: true, assetPath: true },
    });
    const files = versionRow
      ? loadSkillVersionSnapshot({ skillId: skill.id, version: baseVersion, row: versionRow })
      : { 'SKILL.md': '' };

    const mergeInput: MergeIssueInput[] = agg.issues.map((it) => ({
      id: it.id,
      source: it.source,
      severity: it.severity,
      category: it.category,
      summary: it.summary,
      evidence: it.evidence,
      suggestedFix: it.suggestedFix,
      prevalenceCount: it.prevalenceCount,
    }));

    // 建一条 status=running 的空 plan，立刻返回；真正的归并（多轮 LLM）在后台 fire-and-forget
    // 跑，落库后置 draft。前端据 GET /plan?sessionId 轮询 status 直到不再是 running。
    const plan = await (prismaRaw as any).skillOptPlan.create({
      data: {
        sessionId,
        skillId: skill.id,
        baseVersion,
        status: 'running',
        operatorMeta: '{}',
      },
      include: { items: { orderBy: { rank: 'asc' } } },
    });

    void executeMergeOperator({
      planId: plan.id,
      skillName,
      baseVersion,
      issues: mergeInput,
      files,
      config,
      coreBudget: Number.isInteger(body?.coreBudget) ? body.coreBudget : undefined,
      batchSize: Number.isInteger(body?.batchSize) ? body.batchSize : undefined,
    }).catch((err) => {
      console.error('[skill-opt plan] background merge crashed:', err);
    });

    // 只在真正新建 plan 时计数；上面 reused=true 的幂等分支是同一次用户意图，不重复计。
    recordUsageEvent({ user, featureKey: 'skill-opt', eventKey: 'skill.plan.confirm' });

    return NextResponse.json({ plan: serializePlan(plan), reused: false });
  } catch (err: any) {
    // 并发双击「归并」时第二个 create 会撞 sessionId unique——返回已有的
    if (err?.code === 'P2002') {
      const dup = await (prismaRaw as any).skillOptPlan.findUnique({
        where: { sessionId },
        include: { items: { orderBy: { rank: 'asc' } } },
      });
      if (dup) return NextResponse.json({ plan: serializePlan(dup), reused: true });
    }
    console.error('[skill-opt plan POST] failed:', err?.message || err);
    return NextResponse.json({ error: err?.message || 'merge operator failed' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sessionId = String(url.searchParams.get('sessionId') || '').trim();
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  try {
    const plan = await (prismaRaw as any).skillOptPlan.findUnique({
      where: { sessionId },
      include: { items: { orderBy: { rank: 'asc' } } },
    });
    return NextResponse.json({ plan: plan ? serializePlan(plan) : null });
  } catch (err: any) {
    console.error('[skill-opt plan GET] failed:', err?.message || err);
    return NextResponse.json({ error: err?.message || 'failed' }, { status: 500 });
  }
}

function serializePlan(plan: any) {
  return {
    id: plan.id,
    sessionId: plan.sessionId,
    skillId: plan.skillId,
    baseVersion: plan.baseVersion,
    status: plan.status,
    operatorMeta: safeParse(plan.operatorMeta, {}),
    createdAt: plan.createdAt,
    items: (plan.items || []).map((it: any) => ({
      id: it.id,
      rank: it.rank,
      route: it.route,
      status: it.status,
      title: it.title,
      rationale: it.rationale,
      severity: it.severity,
      targetFile: it.targetFile,
      anchorText: it.anchorText,
      proposedEdit: it.proposedEdit,
      conflictNote: it.conflictNote,
      sourceIssueIds: safeParse(it.sourceIssueIds, []),
      sourcesBreakdown: safeParse(it.sourcesBreakdown, {}),
      prevalence: it.prevalence,
    })),
  };
}

function safeParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
