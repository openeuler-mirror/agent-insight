import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { getSkillWorkbenchSession } from '@/lib/skill-workbench/session-service';
import { publishWorkbenchSnapshot, WorkbenchPublishError } from '@/lib/skill-workbench/publish-service';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { id } = await context.params;
    const result = await publishWorkbenchSnapshot({ user: username, sessionId: id, confirmed: body.confirmed === true });
    return NextResponse.json({ ...result, session: await getSkillWorkbenchSession(username, id) });
  } catch (error) {
    if (error instanceof WorkbenchPublishError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[skill-workbench publish POST] failed:', error);
    return NextResponse.json({ error: '发布工作快照失败' }, { status: 500 });
  }
}
