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