import { NextResponse } from 'next/server';
import { traceIdentity, generationErrorResponse } from '@/server/trace-datasets/http';
import { getTraceDatasetManager } from '@/server/trace-datasets/manager';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ deletionId: string }> }) {
  try { const owner = (await traceIdentity(request))!; return NextResponse.json(await (await getTraceDatasetManager()).deletion(owner, (await params).deletionId)); }
  catch (error) { return generationErrorResponse(error); }
}
