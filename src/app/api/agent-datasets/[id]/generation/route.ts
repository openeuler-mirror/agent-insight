import { NextResponse } from 'next/server';
import { traceIdentity, generationErrorResponse } from '@/server/trace-datasets/http';
import { getTraceDatasetManager } from '@/server/trace-datasets/manager';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const owner = (await traceIdentity(request))!; return NextResponse.json(await (await getTraceDatasetManager()).progress(owner, (await params).id)); }
  catch (error) { return generationErrorResponse(error); }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const owner = (await traceIdentity(request))!;
    await (await getTraceDatasetManager()).releaseSummary(owner, (await params).id);
    return new Response(null, { status: 204 });
  } catch (error) { return generationErrorResponse(error); }
}
