/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
