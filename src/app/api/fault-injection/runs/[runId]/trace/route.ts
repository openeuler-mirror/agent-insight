import { NextResponse } from 'next/server'
import { resolveUser } from '@/lib/auth/auth'
import { prisma } from '@/lib/storage/prisma'
import {
  buildFiPipelineMarkers,
  buildFiTraceMarkers,
  mergeEvaluationMarkers,
} from '@/lib/fault-injection/trace-markers'
import { getLatestWorkerInventory } from '@/lib/fault-injection/worker-protocol'
import type { RasEventRow } from '@/lib/ingest/ras/normalize'
import { listRasEventsByTaskIds } from '@/lib/ingest/ras/store'
import { buildRasTraceMarkers } from '@/lib/ingest/ras/trace-markers'

export const dynamic = 'force-dynamic'

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

function modelFromInteractions(interactions: unknown[]): string | null {
  for (const item of interactions) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    if (row.role !== 'assistant') continue
    const modelId =
      asNonEmptyString(row.modelID) ||
      asNonEmptyString(row.model_id) ||
      asNonEmptyString(row.model)
    const providerId =
      asNonEmptyString(row.providerID) || asNonEmptyString(row.provider_id)
    if (modelId && providerId) return `${providerId}/${modelId}`
    if (modelId) return modelId
  }
  return null
}

function modelFromRequestJson(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return asNonEmptyString(parsed.model)
  } catch {
    return null
  }
}

function stampAssistantModel(
  interactions: unknown[],
  model: string | null,
): unknown[] {
  if (!model || !interactions.length) return interactions
  let providerId: string | null = null
  let modelId = model
  if (model.includes('/')) {
    const [provider, rest] = model.split('/', 2)
    providerId = asNonEmptyString(provider)
    modelId = asNonEmptyString(rest) || model
  }
  return interactions.map((item) => {
    if (!item || typeof item !== 'object') return item
    const row = item as Record<string, unknown>
    if (row.role !== 'assistant') return item
    const next = { ...row }
    if (!asNonEmptyString(next.modelID) && !asNonEmptyString(next.model)) {
      next.modelID = modelId
    }
    if (providerId && !asNonEmptyString(next.providerID)) {
      next.providerID = providerId
    }
    return next
  })
}

async function platformDefaultModel(
  user: string | null,
  platform: string,
): Promise<string | null> {
  const inv = await getLatestWorkerInventory(user, platform)
  const models = inv?.platformInventory?.models
  if (!Array.isArray(models)) return null
  for (const row of models) {
    if (!row || typeof row !== 'object') continue
    const rec = row as Record<string, unknown>
    if (rec.default === true) {
      const id = asNonEmptyString(rec.id)
      if (id) return id
    }
  }
  for (const row of models) {
    if (!row || typeof row !== 'object') continue
    const id = asNonEmptyString((row as Record<string, unknown>).id)
    if (id) return id
  }
  return null
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { username } = await resolveUser(req)
  const { runId } = await ctx.params
  const run = await prisma.faultInjectionRun.findUnique({ where: { runId } })
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let interactions: unknown[] = []
  let sessionModel: string | null = null
  if (run.sessionTaskId) {
    const session = await prisma.session.findUnique({ where: { taskId: run.sessionTaskId } })
    if (session?.interactions) {
      try {
        interactions = JSON.parse(session.interactions)
      } catch {
        interactions = []
      }
    }
    sessionModel = asNonEmptyString(session?.model)
  }

  let model: string | null = null
  let taskKey: string | null = null
  let taskName: string | null = null
  if (run.fiTaskId) {
    const task = await prisma.faultInjectionTask.findUnique({ where: { id: run.fiTaskId } })
    model = asNonEmptyString(task?.model)
    taskKey = task?.taskKey || null
    taskName = task?.name || null
  }
  if (!model) model = sessionModel
  if (!model) model = modelFromInteractions(interactions)
  if (!model) model = modelFromRequestJson(run.requestJson)
  if (!model) {
    model = await platformDefaultModel(username || run.user || null, run.platform)
  }

  interactions = stampAssistantModel(interactions, model)

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
      framework: row.framework,
      platform: row.platform,
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
