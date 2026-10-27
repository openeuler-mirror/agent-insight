import { NextResponse } from 'next/server';
import { traceIdentity, generationErrorResponse } from '@/server/trace-datasets/http';
import { getTraceDatasetManager } from '@/server/trace-datasets/manager';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try { const owner = (await traceIdentity(request))!; const result = await (await getTraceDatasetManager()).remove(owner, (await params).id, true); return result ? NextResponse.json(result, { status: 202 }) : new Response(null, { status: 204 }); }
  catch (error) { return generationErrorResponse(error); }
}
