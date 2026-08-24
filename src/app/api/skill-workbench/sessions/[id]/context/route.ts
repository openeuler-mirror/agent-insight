import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { bindSkillWorkbenchContext } from '@/lib/skill-workbench/session-service';

export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });

    const skillName = typeof body.skillName === 'string' ? body.skillName.trim() : '';
    const version = Number(body.version);
    if (!skillName || !Number.isInteger(version) || version < 0) {
      return NextResponse.json({ error: 'skillName 或 version 不合法' }, { status: 400 });
    }

    const { id } = await context.params;
    const session = await bindSkillWorkbenchContext({ user: username, id, skillName, version });
    if (!session) return NextResponse.json({ error: '会话、Skill 或版本不存在，或无访问权限' }, { status: 404 });
    return NextResponse.json({ session });
  } catch (error) {
    console.error('[skill-workbench context PUT] failed:', error);
    return NextResponse.json({ error: '绑定工作 Skill 失败' }, { status: 500 });
  }
}
