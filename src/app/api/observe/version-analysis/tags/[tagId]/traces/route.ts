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
import { TraceTagError } from '@/lib/trace-tags';
import { getVersionTagTraces } from '@/lib/version-analysis';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ tagId: string }> };

function toErrorResponse(error: unknown) {
  if (error instanceof TraceTagError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('[version-analysis/tag/traces] request failed:', error);
  return NextResponse.json({ error: 'failed to load version traces' }, { status: 500 });
}

export async function GET(request: Request, context: RouteContext) {
  try {
    const { tagId } = await context.params;
    const { searchParams } = new URL(request.url);
    return NextResponse.json(await getVersionTagTraces(tagId, {
      user: searchParams.get('user'),
      agent: searchParams.get('agent'),
      framework: searchParams.get('framework'),
      from: searchParams.get('from'),
      to: searchParams.get('to'),
      questionKey: searchParams.get('questionKey'),
      limit: searchParams.get('limit'),
    }));
  } catch (error) {
    return toErrorResponse(error);
  }
}