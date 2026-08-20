import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { listManagedSkills, parseSkillManagementQuery } from '@/lib/skill-workbench/skill-management';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });

    const query = parseSkillManagementQuery(request.nextUrl.searchParams);
    const result = await listManagedSkills(username, query);
    return NextResponse.json(result);
  } catch (error) {
    console.error('[skill-management skills GET] failed:', error);
    return NextResponse.json({ error: '加载 Skill 管理列表失败' }, { status: 500 });
  }
}
