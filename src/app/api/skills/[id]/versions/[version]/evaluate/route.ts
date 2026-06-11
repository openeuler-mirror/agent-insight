import { canAccessSkill, resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import { runStaticEvaluation } from '@/lib/engine/skill-issues/static-evaluator';
import { getActiveConfig } from '@/lib/storage/server-config';
import { NextRequest, NextResponse } from 'next/server';

/**
 * 手动触发当前 SkillVersion 的静态评估（完整 L1+L2 流程，L1 不单独评分）。
 * 未配置评估模型直接 400 拒绝，不创建评估行——不允许单独跑 L1。
 * 同步等待执行；典型耗时数秒～30s。
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

    let body: { user?: string } = {};
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

    // 模型门控：评估必须完整 L1+L2，未配模型直接拒绝（runStaticEvaluation 内部还有同款兜底）。
    const config = await getActiveConfig(username || null);
    if (!config) {
      return NextResponse.json(
        { error: '未配置评估模型，请先在「模型注册」页配置后再评估。' },
        { status: 400 },
      );
    }

    const result = await runStaticEvaluation({
      skillId: id,
      version,
      user: username || null,
      trigger: 'manual',
    });

    return NextResponse.json(result);
  } catch (e: any) {
    console.error('[Static Eval] Manual trigger error:', e);
    return NextResponse.json({ error: e?.message || 'evaluation failed' }, { status: 500 });
  }
}
