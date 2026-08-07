import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'
import type { CollectPayload } from '@/lib/fault-injection/engine'
import { ingestCollectAndJudge, refreshTaskProgress } from '@/lib/fault-injection/store'

export const dynamic = 'force-dynamic'

export async function POST(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  try {
    const { username } = await resolveUser(req)
    if (!username) {
      return NextResponse.json({ error: 'API key required' }, { status: 401 })
    }
    const { runId } = await ctx.params
    const run = await prisma.faultInjectionRun.findFirst({
      where: { runId, user: username },
    })
    if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const body = await req.json()
    const stopped =
      body.stopped === true ||
      run.stopRequested ||
      String(body.error || '').includes('stopped')

    if (run.status === 'stopped' && !body.allowPartial) {
      return NextResponse.json({ error: 'run already stopped' }, { status: 409 })
    }

    if (stopped && (body.skipIngest || !Array.isArray(body.interactions))) {
      await prisma.faultInjectionRun.update({
        where: { id: run.id },
        data: {
          status: 'stopped',
          error: body.error || 'stopped by user',
          stopRequested: true,
        },
      })
      if (run.fiTaskId) await refreshTaskProgress(run.fiTaskId)
      return NextResponse.json({ ok: true, status: 'stopped' })
    }

    const rawTaskId =
      (typeof body.taskId === 'string' && body.taskId.trim()) ||
      (typeof body.sessionTaskId === 'string' && body.sessionTaskId.trim()) ||
      null
    // Never fall back to runId as the RAS alignment key.
    const sessionAligned =
      body.sessionAligned === true ||
      (body.sessionAligned !== false &&
        typeof rawTaskId === 'string' &&
        rawTaskId.length > 0 &&
        rawTaskId !== runId &&
        !/^ras-\d{8}T/.test(rawTaskId) &&
        !/^(msg_|prt_)/.test(rawTaskId))

    const payload = {
      runId,
      taskId: sessionAligned ? rawTaskId : null,
      sessionAligned,
      framework: body.framework || run.platform,
      fault: body.fault || run.fault,
      injectionMethod: body.injectionMethod,
      faultActivated: body.faultActivated,
      faultActivatedAt: body.faultActivatedAt,
      interactions: body.interactions || [],
      markers: body.markers || [],
      injectionEvidence: body.injectionEvidence || {},
    } as CollectPayload

    if (stopped) {
      // Partial ingest then force stopped (do not leave as completed green).
      await ingestCollectAndJudge({ runId, user: username, payload })
      await prisma.faultInjectionRun.update({
        where: { runId },
        data: {
          status: 'stopped',
          error: body.error || 'stopped by user',
          outcome: null,
          stopRequested: true,
        },
      })
      if (run.fiTaskId) await refreshTaskProgress(run.fiTaskId)
      return NextResponse.json({ ok: true, status: 'stopped' })
    }

    if (body.error && !body.interactions?.length) {
      await prisma.faultInjectionRun.update({
        where: { runId },
        data: { status: 'failed', error: String(body.error) },
      })
      if (run.fiTaskId) await refreshTaskProgress(run.fiTaskId)
      return NextResponse.json({ ok: true, status: 'failed' })
    }

    const updated = await ingestCollectAndJudge({ runId, user: username, payload })
    if (run.fiTaskId) await refreshTaskProgress(run.fiTaskId)
    return NextResponse.json({
      ok: true,
      status: updated.status,
      runId: updated.runId,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
