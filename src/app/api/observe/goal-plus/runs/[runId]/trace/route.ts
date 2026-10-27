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
import { getGoalPlusRunTrace } from '@/lib/ingest/goal-plus/query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const url = new URL(request.url);
  const { username } = await resolveUser(request, url.searchParams.get('user'));
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const sourceId = url.searchParams.get('sourceId');
  if (!sourceId) return NextResponse.json({ error: 'sourceId is required' }, { status: 400 });
  const { runId } = await context.params;
  const trace = await getGoalPlusRunTrace(username, sourceId, runId);
  if (!trace) return NextResponse.json({ error: 'Goal Plus run not found' }, { status: 404 });
  return NextResponse.json({ trace });
}
