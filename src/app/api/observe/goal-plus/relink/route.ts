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
import { relinkGoalPlusSource } from '@/lib/ingest/goal-plus/correlate';
import { projectGoalPlusCollaborations } from '@/lib/ingest/collaboration/providers/goal-plus';
import { prismaRaw } from '@/lib/storage/prisma';

export async function POST(request: Request) {
  const { username } = await resolveUser(request);
  if (!username) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const sourceId = typeof body.sourceId === 'string' ? body.sourceId : '';
  if (!sourceId) return NextResponse.json({ error: 'sourceId is required' }, { status: 400 });
  const source = await prismaRaw.goalPlusSource.findUnique({
    where: { user_sourceId: { user: username, sourceId } },
    select: { id: true },
  });
  if (!source) return NextResponse.json({ error: 'Goal Plus source not found' }, { status: 404 });
  const correlation = await relinkGoalPlusSource(source.id);
  let collaborationProjection = null;
  try {
    collaborationProjection = await projectGoalPlusCollaborations(source.id);
  } catch (error) {
    console.warn('[Goal-Plus-Relink] collaboration projection failed:', error);
  }
  return NextResponse.json({ correlation, collaborationProjection });
}
