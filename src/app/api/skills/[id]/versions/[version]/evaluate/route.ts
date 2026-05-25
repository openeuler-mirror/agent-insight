import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import { runStaticEvaluation } from '@/lib/engine/skill-issues/static-evaluator';
import { NextRequest, NextResponse } from 'next/server';

/**
 * 手动触发当前 SkillVersion 的静态评估。
 * 体：{ enableL2?: boolean }（默认 true，未配 LLM 时自动降级为仅 L1）。
 * 同步等待执行；典型耗时：纯 L1 < 50ms，含 L2 数秒～30s。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; version: string }> },
) {
  try {
    const { id, version: versionStr } = await params;
    const version = parseInt(versionStr, 10);
    if (isNaN(version)) {
      return NextResponse.json({ error: 'Invalid version number' }, { status: 400 });
    }

    let body: { enableL2?: boolean; user?: string } = {};
    try { body = await request.json(); } catch { /* 允许空 body */ }

    const { username } = await resolveUser(request, body.user);

    const { allowed, skill } = await canAccessSkill(id, username);
    if (!skill) {
      return NextResponse.json({ error: 'Skill not found' }, { status: 404 });
    }
    if (!allowed) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const sv = await db.findSkillVersion(id, version);
    if (!sv) {
      return NextResponse.json({ error: `Version ${version} not found` }, { status: 404 });
    }

    const result = await runStaticEvaluation({
      skillId: id,
      version,
      user: username || null,
      trigger: 'manual',
      enableL2: body.enableL2 ?? true,
    });

    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[Static Eval] Manual trigger error:', e);
    return NextResponse.json({ error: e?.message || 'evaluation failed' }, { status: 500 });
  }
}
