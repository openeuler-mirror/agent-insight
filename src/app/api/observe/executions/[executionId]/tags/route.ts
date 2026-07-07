import { NextResponse } from 'next/server';
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
    const tags = await replaceExecutionTraceTags(executionId, String(body.user || '').trim(), body.tagIds);
    return NextResponse.json({ tags });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { executionId } = await context.params;
    const body = await request.json();
    const tags = await addExecutionTraceTags(executionId, String(body.user || '').trim(), body.tagIds);
    return NextResponse.json({ tags });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  try {
    const { executionId } = await context.params;
    const { searchParams } = new URL(request.url);
    const tags = await removeExecutionTraceTag(
      executionId,
      searchParams.get('user') || '',
      searchParams.get('tagId') || '',
    );
    return NextResponse.json({ tags });
  } catch (error) {
    return toErrorResponse(error);
  }
}