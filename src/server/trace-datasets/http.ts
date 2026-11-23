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

import { isStorageCoreEnabled } from '@/lib/storage-core/mode';
import { compatibilityContext } from '@/lib/storage-core/compat';

import { NextResponse } from 'next/server';
import { resolveUser } from '@/lib/auth/auth';
import { db } from '@/lib/storage/prisma';
import { GenerationError } from '@/lib/trace-datasets/contracts';
import { PrismaClient } from '@prisma/client';
export async function traceIdentity(request: Request, required = true) {
  return (await compatibilityContext(request)).username;
}
export async function guardTraceDataset(request: Request, id: string, user: string, write = false) {
  {
    const { getCoreDatasetContext,withCoreDatasets,findCoreDataset } = await import('@/lib/storage-core/datasets');
    const actor=await compatibilityContext(request);
    if(actor.username!==user)throw new GenerationError('NOT_FOUND','未找到数据集',404);
    const dataset=getCoreDatasetContext()?await findCoreDataset(id):await withCoreDatasets(request,()=>findCoreDataset(id));
    if(dataset?.generationSource!=='trace')return false;
    if(write&&dataset.generationStatus!=='published')throw new GenerationError('DATASET_NOT_READY','数据集尚未发布，无法编辑或评测',409);
    return true;
  }
}
export function generationErrorResponse(error: unknown) {
  if (error instanceof SyntaxError) return NextResponse.json({ error: { code: 'INVALID_CONFIG', message: '请求必须为有效 JSON' } }, { status: 400 });
  if (error instanceof GenerationError) return NextResponse.json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } }, {
    status: error.status,
    headers: error.code === 'FEATURE_INITIALIZING' || error.code === 'FEATURE_UNAVAILABLE' ? { 'Retry-After': error.code === 'FEATURE_INITIALIZING' ? '2' : '30', 'Cache-Control': 'no-store' } : undefined,
  });
  return NextResponse.json({ error: { code: 'RESOURCE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试' } }, { status: 500 });
}
