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
import { createTraceTag, listTraceTags, TraceTagError } from '@/lib/trace-tags';
import { recordUsageEvent } from '@/lib/usage-analytics/collector';

export const dynamic = 'force-dynamic';

function toErrorResponse(error: unknown) {
  if (error instanceof TraceTagError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('[tags] request failed:', error);
  return NextResponse.json({ error: 'failed to process tags request' }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const user = searchParams.get('user') || '';
    const kind = searchParams.get('kind');
    return NextResponse.json(await listTraceTags(user, kind));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const user = String(body.user || '').trim();
    const tag = await createTraceTag(user, body);

    // 只有版本标签属于「版本管理」功能；其他 kind 的标签不计。
    if ((tag as { kind?: string })?.kind === 'version') {
      recordUsageEvent({ user, featureKey: 'version-management', eventKey: 'version.tag.create' });
    }

    return NextResponse.json(tag, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}