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
import { generationOptions } from '@/server/trace-datasets/catalog';
import { validateWindow } from '@/lib/trace-datasets/contracts';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const owner = (await traceIdentity(request))!;
    const manager = await getTraceDatasetManager();
    const params = new URL(request.url).searchParams, now = Date.now();
    const { from, to } = params.has('from') || params.has('to') ? validateWindow(params.get('from'), params.get('to')) : { from: new Date(now - 7 * 86400000).toISOString(), to: new Date(now).toISOString() };
    const { platforms, agents } = await generationOptions(manager.client, owner, from, to, params.get('platform') || undefined);
    return NextResponse.json({ platforms, agents });
  } catch (error) { return generationErrorResponse(error); }
}
