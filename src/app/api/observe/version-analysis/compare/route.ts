import { NextResponse } from 'next/server';
import { TraceTagError } from '@/lib/trace-tags';
import { getVersionCompare } from '@/lib/version-analysis';

export const dynamic = 'force-dynamic';

function toErrorResponse(error: unknown) {
  if (error instanceof TraceTagError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('[version-analysis/compare] request failed:', error);
  return NextResponse.json({ error: 'failed to load version analysis' }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    return NextResponse.json(await getVersionCompare({
      user: searchParams.get('user'),
      agent: searchParams.get('agent'),
      framework: searchParams.get('framework'),
      from: searchParams.get('from'),
      to: searchParams.get('to'),
      questionKey: searchParams.get('questionKey'),
    }));
  } catch (error) {
    return toErrorResponse(error);
  }
}