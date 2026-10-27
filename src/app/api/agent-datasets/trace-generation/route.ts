import { NextResponse } from 'next/server';
import { traceIdentity, generationErrorResponse } from '@/server/trace-datasets/http';
import { getTraceDatasetManager } from '@/server/trace-datasets/manager';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  try { const owner = (await traceIdentity(request))!; const manager = await getTraceDatasetManager(); return NextResponse.json(await manager.create(owner, await request.json()), { status: 202 }); }
  catch (error) { return generationErrorResponse(error); }
}
