import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  getWorkbenchOptimization,
  startWorkbenchOptimization,
  syncWorkbenchOptimization,
} from '@/lib/skill-workbench/optimization-adapter';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { id } = await context.params;
    const optimization = await getWorkbenchOptimization(username, id);
    if (!optimization) return NextResponse.json({ error: '优化会话不存在' }, { status: 404 });
    return NextResponse.json({ optimization });
  } catch (error) {
    console.error('[skill-workbench optimization GET] failed:', error);
    return NextResponse.json({ error: '加载优化会话失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { id } = await context.params;
    if (body.action === 'sync') {
      const sourceKind = body.sourceKind === 'experiment' || body.sourceKind === 'evaluation' ? body.sourceKind : 'user';
      const result = await syncWorkbenchOptimization({
        user: username,
        sessionId: id,
        sourceKind,
        sourceRefs: Array.isArray(body.sourceRefs) ? body.sourceRefs : [],
        sourceExperimentId: typeof body.sourceExperimentId === 'string' ? body.sourceExperimentId : undefined,
      });
      if (result.kind === 'not_found') return NextResponse.json({ error: '优化会话不存在' }, { status: 404 });
      if (result.kind === 'incomplete') return NextResponse.json(result, { status: 409 });
      return NextResponse.json(result);
    }
    const result = await startWorkbenchOptimization({ user: username, sessionId: id });
    if (!result) return NextResponse.json({ error: '工作台会话没有可优化的 Skill' }, { status: 409 });
    if ('kind' in result && result.kind === 'readonly') {
      return NextResponse.json({ error: '公共或他人的 Skill 为只读，请先上传或发布为自己的 Skill 后再优化' }, { status: 403 });
    }
    return NextResponse.json(result);
  } catch (error) {
    console.error('[skill-workbench optimization POST] failed:', error);
    return NextResponse.json({ error: '更新优化会话失败' }, { status: 500 });
  }
}
