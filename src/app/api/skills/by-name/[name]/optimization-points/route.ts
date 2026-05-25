import { NextRequest, NextResponse } from 'next/server';
import { resolveUser, canAccessSkill } from '@/lib/auth/auth';
import { db, prismaRaw } from '@/lib/storage/prisma';
import { aggregateSkillIssues, type IssueWithPrevalence } from '@/lib/engine/skill-issues';

export const dynamic = 'force-dynamic';

/**
 * GET /api/skills/by-name/:name/optimization-points
 *   ?user=...                必填
 *   &version=N               可选；不传 = 跨版本聚合
 *   &includeResolved=1       可选；默认只返回 resolvedAt=null 的
 *
 * 返回 { issues: OptIssue[] }（与 skill-opt 页 _mock.ts 中 OptIssue 同构）。
 *
 * 内部：从 SkillIssue + Evaluation 两表聚合（aggregator 处理 prevalence + severity 抬升），
 * 再把 IssueWithPrevalence 映射成 OptIssue 形态（category / improvementSuggestion /
 * occurrence / source）。前端只认 OptIssue。
 *
 * 设计文档：docs/plans/2026-05-08-skill-opt-issues-api-design.md
 */
export async function GET(
  request: NextRequest,
  props: { params: Promise<{ name: string }> },
) {
  try {
    const { name: rawName } = await props.params;
    const name = decodeURIComponent(rawName);
    const url = new URL(request.url);
    const versionStr = url.searchParams.get('version');
    const userParam = url.searchParams.get('user');
    const includeResolved = url.searchParams.get('includeResolved') === '1';

    let version: number | undefined;
    if (versionStr !== null && versionStr !== '') {
      const v = Number(versionStr);
      if (!Number.isInteger(v)) {
        return NextResponse.json({ error: 'version must be an integer' }, { status: 400 });
      }
      version = v;
    }

    const { username: user } = await resolveUser(request, userParam);

    // 1) 找 skill；多租户过滤跟 by-name/route.ts 一致
    const where: any = { name };
    if (user) {
      where.OR = [{ user }, { user: null }, { visibility: 'public' }];
    }
    const skills = await db.findSkills(where);
    const skill = skills[0];
    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }

    // 鉴权（与现有 skill 路由一致）
    const { allowed } = await canAccessSkill(skill.id, user);
    if (!allowed) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // 2) 聚合
    const result = await aggregateSkillIssues({
      prisma: prismaRaw as any,
      skillId: skill.id,
      version,
      user,
      includeResolved,
    });

    // 3) 映射成 OptIssue（前端 _mock.ts 同构）
    const issues = result.issues.map(toOptIssue);

    return NextResponse.json({
      skill: name,
      version: version ?? null,
      generatedAt: new Date().toISOString(),
      generator: 'skill-issues@0.1.0',
      issues,
      stats: result.stats,
    });
  } catch (err) {
    console.error('[optimization-points] Error:', err);
    return NextResponse.json(
      { error: 'Failed to load optimization points', detail: (err as Error)?.message },
      { status: 500 },
    );
  }
}

interface OptIssue {
  id: string;
  severity: 'high' | 'medium' | 'low';
  category: string;
  summary: string;
  evidence?: string;
  improvementSuggestion?: string;
  source?: {
    kind: 'trace' | 'fault' | 'log' | 'static';
    label: string;
    url?: string;
  };
  occurrence: number;
  createdAt: string;
}

function toOptIssue(it: IssueWithPrevalence): OptIssue {
  // Evaluation.type ('static'|'dynamic') → OptIssue.source.kind ('static'|'trace')
  // 当前没接 fault/log 来源；feedback 收口到 V2，先映射成 'log' 占位（前端 UI 已支持）。
  let kind: 'trace' | 'fault' | 'log' | 'static';
  let label: string;
  let url: string | undefined;

  if (it.source === 'static' || it.evaluationType === 'static') {
    kind = 'static';
    label = '静态评估';
    url = `/evaluation/${it.evaluationId}`;
  } else if (it.source === 'dynamic' || it.evaluationType === 'dynamic') {
    kind = 'trace';
    if (it.executionTaskId) {
      label = shortTaskId(it.executionTaskId);
      url = `/trace?taskId=${encodeURIComponent(it.executionTaskId)}`;
    } else {
      label = it.evaluationRunId ? it.evaluationRunId.slice(0, 8) : '动态评估';
      url = `/evaluation/${it.evaluationId}`;
    }
  } else {
    kind = 'log';
    label = it.source;
  }

  return {
    id: it.id,
    severity: it.severity,
    category: it.category || categoryFromSource(it),
    summary: it.summary,
    evidence: it.evidence ?? undefined,
    improvementSuggestion: it.suggestedFix ?? undefined,
    source: { kind, label, url },
    occurrence: it.prevalenceCount,
    createdAt: it.createdAt instanceof Date ? it.createdAt.toISOString() : String(it.createdAt),
  };
}

function categoryFromSource(it: IssueWithPrevalence): string {
  if (it.source === 'static' || it.evaluationType === 'static') return '静态扫描';
  return '其它';
}

function shortTaskId(t: string): string {
  if (t.length <= 16) return t;
  return `${t.slice(0, 8)}…${t.slice(-6)}`;
}
