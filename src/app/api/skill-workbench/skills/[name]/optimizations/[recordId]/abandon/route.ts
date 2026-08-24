import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  OptimizationConflictError,
  transitionSkillOptimizationRecord,
} from '@/lib/skill-workbench/optimization-service';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ name: string; recordId: string }> },
) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name, recordId } = await context.params;
    const record = await transitionSkillOptimizationRecord({
      user: username,
      skillName: decodeURIComponent(name),
      recordId,
      to: 'abandoned',
    });
    if (!record) return NextResponse.json({ error: '优化记录不存在或无访问权限' }, { status: 404 });
    return NextResponse.json({ record });
  } catch (error) {
    if (error instanceof OptimizationConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('[skill-workbench optimization abandon POST] failed:', error);
    return NextResponse.json({ error: '放弃优化候选失败' }, { status: 500 });
  }
}
