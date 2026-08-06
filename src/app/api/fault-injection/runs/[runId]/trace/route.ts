import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'
import {
  buildFiPipelineMarkers,
  buildFiTraceMarkers,
  mergeEvaluationMarkers,
} from '@/lib/fault-injection/trace-markers'
import type { RasEventRow } from '@/lib/ingest/ras/normalize'
import { listRasEventsByTaskIds } from '@/lib/ingest/ras/store'
import { buildRasTraceMarkers } from '@/lib/ingest/ras/trace-markers'

export const dynamic = 'force-dynamic'

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  await resolveUser(req)
  const { runId } = await ctx.params
  const run = await prisma.faultInjectionRun.findUnique({ where: { runId } })
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let interactions: unknown[] = []
  if (run.sessionTaskId) {
    const session = await prisma.session.findUnique({ where: { taskId: run.sessionTaskId } })
    if (session?.interactions) {
      try {
        interactions = JSON.parse(session.interactions)
      } catch {
        interactions = []
      }
    }
  }

  let model: string | null = null
  let taskKey: string | null = null
  let taskName: string | null = null
  if (run.fiTaskId) {
    const task = await prisma.faultInjectionTask.findUnique({ where: { id: run.fiTaskId } })
    model = task?.model || null
    taskKey = task?.taskKey || null
    taskName = task?.name || null
  }

  const rawMarkers = JSON.parse(run.markersJson || '[]')
  let markersList = Array.isArray(rawMarkers) ? [...rawMarkers] : []
  const hasEval = markersList.some(
    (m) => m && typeof m === 'object' && (m as { kind?: string }).kind === 'evaluation',
  )
  if (!hasEval && (run.status === 'judge_skipped' || run.status === 'completed' || run.outcome)) {
    markersList = mergeEvaluationMarkers(markersList, {
      skipped: run.status === 'judge_skipped' || !run.outcome,
      outcome: run.outcome,
      reason: run.judgeReason,
      model: null,
    })
  }
  const markers = buildFiTraceMarkers(markersList)
  const pipelineMarkers = buildFiPipelineMarkers(markersList)

  // Real RAS detections for this session (if any) — keep separate from FI markers.
  let rasMarkers: ReturnType<typeof buildRasTraceMarkers> = []
  if (run.sessionTaskId) {
    const rasRows = await listRasEventsByTaskIds({
      taskIds: [run.sessionTaskId],
      user: run.user || undefined,
      limit: 200,
    })
    const eventRows: RasEventRow[] = rasRows.map((row) => ({
      id: row.id,
      deliveryId: row.deliveryId,
      type: row.type,
      taskId: row.taskId,
      anomalyKind: row.anomalyKind,
      severity: row.severity,
      summary: row.summary,
      actionTypes: row.actionTypes,
      payloadJson: row.payloadJson,
      ts: row.ts instanceof Date ? row.ts.toISOString() : String(row.ts),
    }))
    rasMarkers = buildRasTraceMarkers(eventRows, 'zh').map((marker) => ({
      ...marker,
      source: 'ras' as const,
    }))
  }

  return NextResponse.json({
    taskId: run.sessionTaskId,
    taskKey,
    taskName,
    framework: run.platform,
    fault: run.fault,
    submode: run.submode,
    model,
    runId: run.runId,
    status: run.status,
    error: run.error,
    judge: {
      outcome: run.outcome,
      faultContainmentStatus: run.faultContainmentStatus,
      reason: run.judgeReason,
    },
    interactions,
    markers,
    pipelineMarkers,
    rasMarkers,
    // Never promote FI markers into RAS timeline rows.
    reliabilityEvents: [],
  })
}
