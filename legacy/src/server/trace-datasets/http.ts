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
import { db } from '@/lib/storage/prisma';
import { GenerationError } from '@/lib/trace-datasets/contracts';
import { PrismaClient } from '@prisma/client';
export async function traceIdentity(request: Request, required = true) {
  const key = request.headers.get('x-witty-api-key');
  const username = key ? (await resolveUser(new Request('http://localhost/', { headers: { 'x-witty-api-key': key } }))).username : null;
  if (!username && required) throw new GenerationError('UNAUTHENTICATED', '请重新登录后操作', 401);
  return username;
}
export async function guardTraceDataset(request: Request, id: string, user: string, write = false) {
  const client = db.getClient();
  if (!(client instanceof PrismaClient)) return false;
  const dataset = await client.agentEvalDataset.findUnique({ where: { id }, select: { generationSource: true, generationStatus: true, user: true, generationJob: { select: { status: true, deletionId: true } } } });
  if (dataset?.generationSource !== 'trace') return false;
  const owner = await traceIdentity(request);
  if (owner !== user || dataset.user !== owner) throw new GenerationError('NOT_FOUND', '未找到数据集', 404);
  if (dataset.generationJob?.status === 'deleting') throw new GenerationError('DATASET_DELETING', '正在删除', 409, { deletionId: dataset.generationJob.deletionId! });
  if (write && dataset.generationStatus !== 'published') throw new GenerationError('DATASET_NOT_READY', '数据集尚未发布，无法编辑或评测', 409);
  return true;
}
export function generationErrorResponse(error: unknown) {
  if (error instanceof SyntaxError) return NextResponse.json({ error: { code: 'INVALID_CONFIG', message: '请求必须为有效 JSON' } }, { status: 400 });
  if (error instanceof GenerationError) return NextResponse.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, {
    status: error.status,
    headers: error.code === 'FEATURE_INITIALIZING' || error.code === 'FEATURE_UNAVAILABLE' ? { 'Retry-After': error.code === 'FEATURE_INITIALIZING' ? '2' : '30', 'Cache-Control': 'no-store' } : undefined,
  });
  return NextResponse.json({ error: { code: 'RESOURCE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' } }, { status: 500 });
}
