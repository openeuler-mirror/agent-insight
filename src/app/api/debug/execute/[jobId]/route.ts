import { NextResponse } from 'next/server';
import { prisma } from '@/lib/storage/prisma';
import type { DebugJob } from '../route';

export const dynamic = 'force-dynamic';

declare global {
  // eslint-disable-next-line no-var
  var __debugJobStore: Map<string, DebugJob> | undefined;
}

/**
 * GET /api/debug/execute/[jobId]
 *
 * Poll job status. Checks in-memory store first, then DB as fallback.
 * Returns:
 *   { status: 'running' }
 *   { status: 'completed', output, timeCost, tokenUsage }
 *   { status: 'failed', error }
 *
 * Never returns 404 — unknown jobs return { status: 'failed' } so the
 * client poll loop terminates cleanly instead of looping forever.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;

  // 1. Check in-memory store first (fast path)
  const memJob = globalThis.__debugJobStore?.get(jobId);
  if (memJob) {
    if (memJob.status === 'running') return NextResponse.json({ status: 'running' });
    if (memJob.status === 'completed') {
      return NextResponse.json({ status: 'completed', output: memJob.output, timeCost: memJob.timeCost, tokenUsage: memJob.tokenUsage, sessionId: memJob.sessionId });
    }
    return NextResponse.json({ status: 'failed', error: memJob.error });
  }

  // 2. Fall back to DB (survives server restarts)
  try {
    const dbJob = await (prisma as any).debugJobResult.findUnique({ where: { id: jobId } });
    if (dbJob) {
      if (dbJob.status === 'completed') {
        return NextResponse.json({ status: 'completed', output: dbJob.output, timeCost: dbJob.timeCost, tokenUsage: dbJob.tokenUsage, sessionId: dbJob.sessionId });
      }
      return NextResponse.json({ status: 'failed', error: dbJob.error || 'agent failed' });
    }
  } catch {
    // DB unavailable — fall through
  }

  // 3. Job unknown: server restarted before job completed and result was never persisted.
  //    Return failed (not 404) so poll loop terminates cleanly.
  return NextResponse.json({ status: 'failed', error: 'Job not found — server may have restarted during execution' });
}
