import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import { retestOptimizationCandidate, RetestError } from '@/lib/skill-workbench/retest-service';

export async function POST(request: NextRequest, context: { params: Promise<{ name: string; recordId: string }> }) {
  try {
    const body = await request.json();
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { name, recordId } = await context.params;
    const result = await retestOptimizationCandidate({ user: username, skillName: decodeURIComponent(name), recordId });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RetestError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[skill-workbench retest POST] failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '候选复测失败' }, { status: 500 });
  }
}
