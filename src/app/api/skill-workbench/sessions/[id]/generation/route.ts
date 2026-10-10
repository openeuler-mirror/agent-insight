import { NextRequest, NextResponse } from 'next/server';

import { resolveUser } from '@/lib/auth/auth';
import {
  getWorkbenchGeneration,
  startWorkbenchGeneration,
  syncWorkbenchGeneration,
} from '@/lib/skill-workbench/generation-service';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { id } = await context.params;
    const generation = await getWorkbenchGeneration(username, id);
    if (!generation) return NextResponse.json({ error: '生成会话不存在' }, { status: 404 });
    return NextResponse.json({ generation });
  } catch (error) {
    console.error('[skill-workbench generation GET] failed:', error);
    return NextResponse.json({ error: '加载生成会话失败' }, { status: 500 });
  }
}

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const body = await request.json().catch(() => ({}));
    const { username } = await resolveUser(request, body.user);
    if (!username) return NextResponse.json({ error: '缺少用户信息' }, { status: 401 });
    const { id } = await context.params;
    const result = body.action === 'sync'
      ? await syncWorkbenchGeneration(username, id)
      : await startWorkbenchGeneration(username, id);
    if (!result) return NextResponse.json({ error: '工作台会话不存在' }, { status: 404 });
    if ('kind' in result && result.kind === 'not_found') return NextResponse.json({ error: '生成会话不存在' }, { status: 404 });
    if ('kind' in result && result.kind === 'incomplete') return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[skill-workbench generation POST] failed:', error);
    return NextResponse.json({ error: '更新生成会话失败' }, { status: 500 });
  }
}
