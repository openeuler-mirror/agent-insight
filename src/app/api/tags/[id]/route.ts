import { NextResponse } from 'next/server';
import { deleteTraceTag, updateTraceTag, TraceTagError } from '@/lib/trace-tags';

export const dynamic = 'force-dynamic';

function toErrorResponse(error: unknown) {
  if (error instanceof TraceTagError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('[tags/id] request failed:', error);
  return NextResponse.json({ error: 'failed to process tag request' }, { status: 500 });
}

type RouteContext = { params: Promise<{ id: string }> };

export async function PUT(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const user = String(body.user || '').trim();
    return NextResponse.json(await updateTraceTag(user, id, body));
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    const { searchParams } = new URL(request.url);
    await deleteTraceTag(searchParams.get('user') || '', id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}