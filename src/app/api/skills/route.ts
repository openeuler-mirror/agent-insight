import { resolveUser } from '@/lib/auth/auth';
import { db, prisma, prismaRaw } from '@/lib/storage/prisma';
import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { deleteEnterpriseSkill, fetchEnterpriseSkillInfo } from '@/lib/engine/skill-generation/legacy/skill-sync-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const query = searchParams.get('query');
    const category = searchParams.get('category');
    const userParam = searchParams.get('user');

    const { username: user } = await resolveUser(request, userParam);

    const where: any = {};

    if (user) {
        where.OR = [
            { user: user },
            { user: null },
            { visibility: 'public' }
        ];
    }

    if (query) {
      const queryFilter = {
        OR: [
          { name: { contains: query } },
          { description: { contains: query } }
        ]
      };
      if (where.OR) {
          where.AND = [
              { OR: where.OR },
              queryFilter
          ];
          delete where.OR;
      } else {
          where.OR = queryFilter.OR;
      }
    }

    if (category && category !== '全部') {
      where.category = category;
    }

    const skills = await db.findSkills(where);

    skills.sort((a: any, b: any) => {
      const v0A = a.versions?.find((v: any) => v.version === 0);
      const v0B = b.versions?.find((v: any) => v.version === 0);
      const timeA = v0A ? new Date(v0A.createdAt).getTime() : 0;
      const timeB = v0B ? new Date(v0B.createdAt).getTime() : 0;
      return timeB - timeA;
    });

    // 一次性拉 7d 内、命中本批 skill 名字的 Execution，避免每个 skill 单独查；
    // 多 skill 同名的情况由 skill.name 自然聚合（业务上不允许同 user 同名）。
    const skillNames = skills.map((s: any) => s.name).filter(Boolean);
    const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    let execAggMap: Map<string, { calls: number; agents: Set<string>; success: number; total: number }> = new Map();
    let issueAggMap: Map<string, { high: number; medium: number; low: number }> = new Map();
    let evaluatedSkillIds = new Set<string>();

    if (skillNames.length > 0) {
        try {
            const execs = await prismaRaw.execution.findMany({
                where: { skill: { in: skillNames }, timestamp: { gte: since7d } },
                select: { skill: true, agentName: true, isAnswerCorrect: true, failures: true },
            });
            for (const e of execs) {
                if (!e.skill) continue;
                let agg = execAggMap.get(e.skill);
                if (!agg) { agg = { calls: 0, agents: new Set(), success: 0, total: 0 }; execAggMap.set(e.skill, agg); }
                agg.calls += 1;
                agg.total += 1;
                if (e.agentName) agg.agents.add(e.agentName);
                const failed = e.isAnswerCorrect === false
                    || (e.failures && e.failures !== '[]' && e.failures !== 'null' && (() => {
                        try { const arr = JSON.parse(e.failures); return Array.isArray(arr) && arr.length > 0; } catch { return false; }
                    })());
                if (!failed) agg.success += 1;
            }
        } catch (e) {
            console.warn('[Skills List] failed to aggregate executions:', (e as any)?.message);
        }

        // 聚合活跃版本最近一次静态评估的 issue，用于质量分；与 Skill 版本详情页生命周期口径保持一致。
        try {
            const skillIds = skills.map((s: any) => s.id);
            const evaluations = await prismaRaw.evaluation.findMany({
                where: { skillId: { in: skillIds }, type: 'static' },
                orderBy: { ranAt: 'desc' },
                include: { issues: { select: { severity: true } } },
            });
            for (const s of skills) {
                const av = s.activeVersion || 0;
                const latest = evaluations.find(e => e.skillId === s.id && e.version === av);
                if (!latest) continue;
                evaluatedSkillIds.add(s.id);
                const buckets = { high: 0, medium: 0, low: 0 };
                for (const it of latest.issues) {
                    if (it.severity === 'high') buckets.high += 1;
                    else if (it.severity === 'medium') buckets.medium += 1;
                    else buckets.low += 1;
                }
                issueAggMap.set(s.id, buckets);
            }
        } catch (e) {
            console.warn('[Skills List] failed to aggregate skill issues:', (e as any)?.message);
        }
    }

    // 4-bar 质量分：高=0 中≤1 → 4 优秀；中=2-3 → 3 良好；高=1 或 中>3 → 2 待优化；高>1 → 1 风险。
    const qualityFromIssues = (b: { high: number; medium: number; low: number }) => {
        if (b.high > 1) return 1;
        if (b.high === 1 || b.medium > 3) return 2;
        if (b.medium >= 2) return 3;
        return 4;
    };

    const response = skills.map((s: any) => {
      const activeVerObj = s.versions?.find((v: any) => v.version === (s.activeVersion || 0));
      const displayDescription = activeVerObj?.changeLog || s.description;
      const displayTime = activeVerObj?.createdAt ? new Date(activeVerObj.createdAt).toISOString() : s.updatedAt.toISOString();

      const agg = execAggMap.get(s.name);
      const calls7d = agg?.calls || 0;
      const agentsUsing = agg ? agg.agents.size : 0;
      const successRate = agg && agg.total > 0 ? Number(((agg.success / agg.total) * 100).toFixed(1)) : null;

      const issues = issueAggMap.get(s.id) || { high: 0, medium: 0, low: 0 };
      const qualityScore = evaluatedSkillIds.has(s.id) ? qualityFromIssues(issues) : 0;

      return {
        id: s.id,
        name: s.name,
        description: displayDescription,
        category: s.category,
        tags: s.tags ? JSON.parse(s.tags) : [],
        author: s.author,
        updatedAt: displayTime,
        version: s.activeVersion || 0,
        activeVersion: s.activeVersion || 0,
        visibility: s.visibility,
        qualityScore,
        qualityIssues: issues,
        usageCount: calls7d,
        calls7d,
        agentsUsing,
        successRate,
        isUploaded: s.isUploaded,
        versions: s.versions?.map((v: any) => ({
          id: v.id,
          version: v.version,
          createdAt: v.createdAt ? new Date(v.createdAt).toISOString() : '',
          changeLog: v.changeLog
        })) || []
      };
    });

    return NextResponse.json(response);
  } catch (error) {
    console.error('Fetch Skills Error:', error);
    return NextResponse.json({ error: 'Failed to fetch skills' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const id = searchParams.get('id');
  const userParam = searchParams.get('user');
  if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 });

  try {
    const { username: user } = await resolveUser(request, userParam);

    const skill = await db.findSkillById(id);
    if (!skill) return NextResponse.json({ error: 'Skill not found' }, { status: 404 });

    if (user && skill.user && skill.user !== user) {
        return NextResponse.json({ error: 'Unauthorized delete' }, { status: 403 });
    }

    // 企业模式：先删除对应的企业skill（带版本检查）
    if (process.env.ORGANIZATION_MODE === 'true') {
      try {
        const incomingCookie = request.headers.get('cookie') || undefined;
        console.log('[Delete-Skill] 企业模式，开始删除企业skill');

        // 获取所有版本的企业skill id
        const versions = skill.versions || [];
        for (const version of versions) {
          if (version.enterpriseSkillId) {
            console.log('[Delete-Skill] 检查企业skill ID:', version.enterpriseSkillId);

            // 查询企业skill的版本号
            const enterpriseVersion = await fetchEnterpriseSkillInfo(
              version.enterpriseSkillId,
              incomingCookie
            );

            // 本地skill的版本号
            const localVersion = version.semanticVersion;

            console.log('[Delete-Skill] 本地版本:', localVersion, '企业版本:', enterpriseVersion);

            // 版本一致性检查
            if (localVersion === enterpriseVersion) {
              console.log('[Delete-Skill] 版本一致，删除企业skill');
              await deleteEnterpriseSkill(version.enterpriseSkillId, incomingCookie);
            } else {
              console.log('[Delete-Skill] 版本不一致，跳过删除（企业已有新版本）');
            }
          }
        }
      } catch (error: any) {
        console.error('[Delete-Skill] 企业删除失败，继续删除本地skill:', error);
        console.error('[Delete-Skill] 错误信息:', error.message);
      }
    }

    const storagePath = path.join(process.cwd(), 'data', 'storage', 'skills', id);

    if (fs.existsSync(storagePath)) {
      fs.rmSync(storagePath, { recursive: true, force: true });
    }

    await db.deleteSkill(id);

    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error('Delete Skill Error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
