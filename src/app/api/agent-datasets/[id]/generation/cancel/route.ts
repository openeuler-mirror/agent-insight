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
import { traceIdentity, generationErrorResponse } from '@/server/trace-datasets/http';
import { getTraceDatasetManager } from '@/server/trace-datasets/manager';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const owner = (await traceIdentity(request))!; const result = await (await getTraceDatasetManager()).remove(owner, (await params).id, true); return result ? NextResponse.json(result, { status: 202 }) : new Response(null, { status: 204 }); }
  catch (error) { return generationErrorResponse(error); }
}
