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
import { deleteExperimentExecution } from '@/lib/engine/experiment/cancellation-service';
import { prisma } from '@/lib/storage/prisma';

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string; caseId: string }> }) {
  try {
    const { username } = await resolveUser(req, new URL(req.url).searchParams.get('user'));
    if (!username) return NextResponse.json({ error: 'user is required' }, { status: 400 });
    const { id, caseId } = await params;
    const cancellation = await deleteExperimentExecution(username, id, caseId);
    const experiment = await prisma.experiment.findUnique({ where: { id }, select: { deletedAt: true } });
    return NextResponse.json({ deleted: true, experimentDeleted: Boolean(experiment?.deletedAt), cancellation },
      { status: cancellation.status === 'completed' ? 200 : 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '删除失败' },
      { status: Number((error as { status?: number }).status) || 500 });
  }
}
