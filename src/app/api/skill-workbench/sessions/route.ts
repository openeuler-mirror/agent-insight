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
  createSkillWorkbenchSession,
  listSkillWorkbenchSessions,
} from '@/lib/skill-workbench/session-service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { username } = await resolveUser(request, request.nextUrl.searchParams.get('user'));
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    return NextResponse.json({ sessions: await listSkillWorkbenchSessions(username) });
  } catch (error) {
    console.error('[skill-workbench sessions GET] failed:', error);
    return NextResponse.json({ error: 'Failed to load workbench sessions' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const { username } = await resolveUser(request, body.user);
    if (!username) {
      return NextResponse.json({ error: 'user is required' }, { status: 400 });
    }
    const session = await createSkillWorkbenchSession({
      user: username,
      title: typeof body.title === 'string' ? body.title : undefined,
    });
    return NextResponse.json({ session }, { status: 201 });
  } catch (error) {
    console.error('[skill-workbench sessions POST] failed:', error);
    return NextResponse.json({ error: 'Failed to create workbench session' }, { status: 500 });
  }
}
