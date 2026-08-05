import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'
import {
  buildFiPipelineMarkers,
  buildFiReliabilityEvents,
  buildFiTraceMarkers,
  mergeEvaluationMarkers,
} from '@/lib/fault-injection/trace-markers'

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
    reliabilityEvents: buildFiReliabilityEvents(markers),
  })
}
