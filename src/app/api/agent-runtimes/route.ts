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

import { NextResponse } from 'next/server';

import {
  AgentRuntimeSelectionError,
  getAgentRuntimeOverview,
  saveAgentRuntimeSelection,
} from '@/lib/engine/agent-runtime/preference';

export const dynamic = 'force-dynamic';

function readUser(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * GET /api/agent-runtimes?user=<user>&refresh=1
 *
 * 探测当前服务所在部署环境可访问的 Agent 运行时。探测不调用模型、不安装依赖；
 * `refresh=1` 跳过 30 秒缓存，对应页面上的「重新检测」。
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const user = readUser(searchParams.get('user'));
  if (!user) return NextResponse.json({ error: 'User is required', code: 'USER_REQUIRED' }, { status: 400 });

  try {
    const overview = await getAgentRuntimeOverview(user, { force: searchParams.get('refresh') === '1' });
    return NextResponse.json(overview);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[agent-runtimes] GET error:', message);
    return NextResponse.json({ error: message, code: 'DETECTION_FAILED' }, { status: 500 });
  }
}

/**
 * PUT /api/agent-runtimes
 * body: { user: string, runtimeId: string | null }
 *
 * runtimeId=null 表示清除个人偏好。不可用的运行时不会被保存，避免静默回退。
 */
export async function PUT(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'INVALID_BODY' }, { status: 400 });
  }

  const user = readUser(body.user);
  if (!user) return NextResponse.json({ error: 'User is required', code: 'USER_REQUIRED' }, { status: 400 });
  if (!('runtimeId' in body)) {
    return NextResponse.json({ error: 'runtimeId is required (use null to clear)', code: 'INVALID_BODY' }, { status: 400 });
  }
  if (body.runtimeId !== null && typeof body.runtimeId !== 'string') {
    return NextResponse.json({ error: 'runtimeId must be a string or null', code: 'INVALID_BODY' }, { status: 400 });
  }

  try {
    const overview = await saveAgentRuntimeSelection(user, body.runtimeId, { force: true });
    return NextResponse.json(overview);
  } catch (error) {
    if (error instanceof AgentRuntimeSelectionError) {
      return NextResponse.json(
        { error: error.message, code: error.code, reason: error.reason ?? null },
        { status: error.status },
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[agent-runtimes] PUT error:', message);
    return NextResponse.json({ error: message, code: 'SAVE_FAILED' }, { status: 500 });
  }
}
