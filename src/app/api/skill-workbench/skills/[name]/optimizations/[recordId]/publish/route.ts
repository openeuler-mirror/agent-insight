import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { publishOptimizationCandidate, WorkbenchPublishError } from '@/lib/skill-workbench/publish-service';
import { getSkillWorkbenchSession } from '@/lib/skill-workbench/session-service';

export async function POST(request: NextRequest, context: { params: Promise<{ name: string; recordId: string }> }) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name, recordId } = await context.params;
    const result = await publishOptimizationCandidate({
      user: username,
      skillName: decodeURIComponent(name),
      recordId,
      confirmed: body.confirmed === true,
    });
    return NextResponse.json({
      ...result,
      session: await getSkillWorkbenchSession(username, result.sessionId),
    });
  } catch (error) {
    if (error instanceof WorkbenchPublishError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error('[skill-workbench optimization publish POST] failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '发布优化候选失败' }, { status: 500 });
  }
}
