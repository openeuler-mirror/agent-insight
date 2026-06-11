/**
 * 优化计划（归并算子）API。
 *
 * POST /api/skill-opt/plan
 *   body: { user, skillName, baseVersion, sessionId, coreBudget?, batchSize? }
 *   幂等：同 sessionId 已有 plan 时直接返回既有 plan（不重跑算子）。
 *   流程：聚合 (skill, baseVersion) 未解决 issues → runMergeOperator → 持久化 plan + items。
 *
 * GET /api/skill-opt/plan?sessionId=...&user=...
 *   返回该会话的 plan + items（无则 { plan: null }）。
 *
 * SkillIssue 台账只读不写；resolve 回标发生在 iteration 落库时（见 iterations 路由）。
 * 设计：docs/plans/2026-06-10-skill-issue-merge-conflict-plan-design.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, prismaRaw } from '@/lib/storage/prisma';
import { resolveUser, canAccessSkill } from '@/lib/auth/auth';
import { getActiveConfig, getUserSettings } from '@/lib/storage/server-config';
import { aggregateSkillIssues } from '@/lib/engine/skill-issues';
import { runMergeOperator, type MergeIssueInput } from '@/lib/engine/skill-opt/merge-operator';
import { loadSkillVersionSnapshot } from '@/lib/engine/skill-opt/version-snapshot';

export const dynamic = 'force-dynamic';

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
    // 幂等：该会话已有 plan 直接返回
    const existing = await (prismaRaw as any).skillOptPlan.findUnique({
      where: { sessionId },
      include: { items: { orderBy: { rank: 'asc' } } },
    });
    if (existing) {
      return NextResponse.json({ plan: serializePlan(existing), reused: true });
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

    const result = await runMergeOperator({
      skillName,
      baseVersion,
      issues: mergeInput,
      files,
      config,
      coreBudget: Number.isInteger(body?.coreBudget) ? body.coreBudget : undefined,
      batchSize: Number.isInteger(body?.batchSize) ? body.batchSize : undefined,
    });

    // 持久化（再查一次防并发双跑——sessionId unique 约束兜底）
    const plan = await (prismaRaw as any).skillOptPlan.create({
      data: {
        sessionId,
        skillId: skill.id,
        baseVersion,
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
      include: { items: { orderBy: { rank: 'asc' } } },
    });

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
