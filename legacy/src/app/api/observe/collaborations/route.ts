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

import { resolveUser } from '@/lib/auth/auth';
import { listCollaborations } from '@/lib/ingest/collaboration/query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { username } = await resolveUser(request);
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const limit = Number(url.searchParams.get('limit') || 50);
  const result = await listCollaborations(username, {
    limit: Number.isFinite(limit) ? limit : 50,
    cursor: url.searchParams.get('cursor') || undefined,
  });
  return NextResponse.json(result);
}
