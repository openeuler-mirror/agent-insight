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
import { recordUsageEvent } from '@/lib/usage-analytics/collector';
import {
  addExecutionTraceTags,
  getExecutionTraceTags,
  removeExecutionTraceTag,
  replaceExecutionTraceTags,
  TraceTagError,
} from '@/lib/trace-tags';

export const dynamic = 'force-dynamic';

function toErrorResponse(error: unknown) {
  if (error instanceof TraceTagError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('[execution-tags] request failed:', error);
  return NextResponse.json({ error: 'failed to process execution tags request' }, { status: 500 });
}

type RouteContext = { params: Promise<{ executionId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { executionId } = await context.params;
    const { searchParams } = new URL(request.url);
    return NextResponse.json({ tags: await getExecutionTraceTags(executionId, searchParams.get('user') || '') });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { executionId } = await context.params;
    const body = await request.json();
    const user = String(body.user || '').trim();
    const tags = await replaceExecutionTraceTags(executionId, user, body.tagIds);

    recordUsageEvent({ user, featureKey: 'trace', eventKey: 'trace.tag.bind' });

    return NextResponse.json({ tags });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { executionId } = await context.params;
    const body = await request.json();
    const user = String(body.user || '').trim();
    const tags = await addExecutionTraceTags(executionId, user, body.tagIds);

    recordUsageEvent({ user, featureKey: 'trace', eventKey: 'trace.tag.bind' });

    return NextResponse.json({ tags });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { executionId } = await context.params;
    const { searchParams } = new URL(request.url);
    const user = searchParams.get('user') || '';
    const tags = await removeExecutionTraceTag(
      executionId,
      user,
      searchParams.get('tagId') || '',
    );

    recordUsageEvent({ user, featureKey: 'trace', eventKey: 'trace.tag.unbind' });

    return NextResponse.json({ tags });
  } catch (error) {
    return toErrorResponse(error);
  }
}