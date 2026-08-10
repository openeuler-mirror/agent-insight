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