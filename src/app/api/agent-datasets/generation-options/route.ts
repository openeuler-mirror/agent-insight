import { NextResponse } from 'next/server';
import { traceIdentity, generationErrorResponse } from '@/server/trace-datasets/http';
import { getTraceDatasetManager } from '@/server/trace-datasets/manager';
import { generationOptions } from '@/server/trace-datasets/catalog';
import { validateWindow } from '@/lib/trace-datasets/contracts';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try {
    const owner = (await traceIdentity(request))!;
    const manager = await getTraceDatasetManager();
    const params = new URL(request.url).searchParams, now = Date.now();
    const { from, to } = params.has('from') || params.has('to') ? validateWindow(params.get('from'), params.get('to')) : { from: new Date(now - 7 * 86400000).toISOString(), to: new Date(now).toISOString() };
    const { platforms, agents } = await generationOptions(manager.client, owner, from, to, params.get('platform') || undefined);
    return NextResponse.json({ platforms, agents });
  } catch (error) { return generationErrorResponse(error); }
}
