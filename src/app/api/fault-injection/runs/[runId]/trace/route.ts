import {findCoreFiRun,findCoreFiTask,coreFiOwner} from '@/lib/storage-core/fault-injection'
import {requireCoreControlContext} from '@/lib/storage-core/control-context'
import {withCoreFiRequest} from '@/lib/storage-core/fault-injection'
/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { NextResponse } from 'next/server'
import { resolveFiUser as resolveUser } from '@/lib/storage-core/fault-injection'
import { prisma } from '@/lib/storage/prisma'
import { isStorageCoreEnabled } from '@/lib/storage-core/mode'
import { readTraceEvidence } from '@/lib/storage-core/evidence'
import { readCoreRasEvents, analyticsFailure } from '@/lib/storage-core/analytics'
import {
  buildFiPipelineMarkers,
  buildFiTraceMarkers,
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

async function handleGET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  try {
  const core = isStorageCoreEnabled()
  const sourceRequest=core ? requireCoreControlContext().request || req : req
  const username = core ? coreFiOwner() : (await resolveUser(req)).username
  if (core && !username) throw Object.assign(new Error('Verified FI owner required'), {status: 403})
  const { runId } = await ctx.params
  const run = core ? await findCoreFiRun(runId) : await prisma.faultInjectionRun.findUnique({ where: { runId } })
  if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 })

  let interactions: unknown[] = []
  let sessionModel: string | null = null
  let sourceSnapshot: string | null = null
  if (run.sessionTaskId) {
    if (core) {
      try {
        const {evidence} = await readTraceEvidence(sourceRequest, {taskId: run.sessionTaskId})
        if(evidence.execution.user!==run.user)throw Object.assign(new Error('FI business Trace owner differs'),{status:403})
        interactions = evidence.session.interactions
        sessionModel = asNonEmptyString(evidence.session.model)
        sourceSnapshot = evidence.snapshot_hash
      } catch (error) {
        if ((error as {status?: number})?.status !== 404) throw error
      }
    } else {
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
  }

  let model: string | null = null
  let taskKey: string | null = null
  let taskName: string | null = null
  if (run.fiTaskId) {
    const task = core ? await findCoreFiTask(run.fiTaskId) : await prisma.faultInjectionTask.findUnique({ where: { id: run.fiTaskId } })
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
  // Existing evaluation markers are historical evidence, never synthesize new ones.
  const markersList = Array.isArray(rawMarkers) ? rawMarkers : []
  const markers = buildFiTraceMarkers(markersList)
  const pipelineMarkers = buildFiPipelineMarkers(markersList)

  // Real RAS detections for this session (if any) — keep separate from FI markers.
  let rasMarkers: ReturnType<typeof buildRasTraceMarkers> = []
  let rasSelection: Awaited<ReturnType<typeof readCoreRasEvents>> | null = null
  if (run.sessionTaskId) {
    rasSelection = core ? await readCoreRasEvents(sourceRequest, [run.sessionTaskId], {limit: 200}) : null
    const rasRows = core ? rasSelection!.events : await listRasEventsByTaskIds({
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

  if (sourceSnapshot && run.sessionTaskId) {
    const {evidence} = await readTraceEvidence(sourceRequest, {taskId: run.sessionTaskId})
    if (evidence.snapshot_hash !== sourceSnapshot) throw Object.assign(new Error('FI Trace source changed'), {status: 409})
  }
  if (rasSelection) await rasSelection.validate()

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
    judge: run.judgedAt ? {
      outcome: run.outcome,
      faultContainmentStatus: run.faultContainmentStatus,
      reason: run.judgeReason,
    } : null,
    interactions,
    markers,
    pipelineMarkers,
    rasMarkers,
    // Never promote FI markers into RAS timeline rows.
    reliabilityEvents: [],
  })
  } catch (error) {
    if (isStorageCoreEnabled()) return analyticsFailure(error)
    throw error
  }
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ runId: string }> },) {
  return withCoreFiRequest(req,()=>handleGET(req,ctx))
}
