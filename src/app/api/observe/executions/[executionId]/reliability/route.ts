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
import { prisma } from '@/lib/storage/prisma'
import { deriveAnomalyStatus } from '@/lib/reliability/anomaly-status'
import { buildRasTraceMarkers } from '@/lib/ingest/ras/trace-markers'
import type { RasEventRow } from '@/lib/ingest/ras/normalize'
import { isStorageCoreEnabled } from '@/lib/storage-core/mode'
import { readTraceExecution } from '@/lib/storage-core/evidence'
import { readCoreRasEvents, analyticsFailure } from '@/lib/storage-core/analytics'
import {withCoreReadRetry,coreReadChanged} from '@/lib/storage-core/read-retry'

export const dynamic = 'force-dynamic'

/** IF-N14：Trace 可靠性详情（无数据时仍 200 + unknown）。 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ executionId: string }> },
) {

  try{return await withCoreReadRetry(req,()=>readReliability(req,params))}
  catch(error){return analyticsFailure(error)}
}

async function readReliability(req:Request,params:Promise<{executionId:string}>) {
  try {
    const { executionId } = await params
    const id = String(executionId || '').trim()
    if (!id) {
      return NextResponse.json({ error: 'executionId is required' }, { status: 400 })
    }

    const url = new URL(req.url)
    const locale = url.searchParams.get('locale') === 'en' ? 'en' : 'zh'

    const core = isStorageCoreEnabled()
    let executionSnapshot: string | null = null
    let executionIdentity: Record<string,unknown> | null = null
    let execution: {id: string; taskId: string | null; finalResult: string | null} | null = null
    {
      try {
        const {evidence} = await readTraceExecution(req, {executionId: id})
        executionSnapshot = evidence.snapshot_hash
        executionIdentity = evidence.manifest
        execution = {id: evidence.execution.id, taskId: evidence.execution.taskId, finalResult: evidence.execution.finalResult ?? null}
      } catch (error) {
        if ((error as {status?: number})?.status !== 404) throw error
      }
    }

    const taskId = execution?.taskId || ''
    const coreEvents = core && taskId ? await readCoreRasEvents(req, [taskId], {limit: 200, order: 'asc'}) : null
    const events = (coreEvents?.events || [])

    const rows: RasEventRow[] = events.map((event: {
      id: string
      deliveryId: string
      type: string
      taskId: string
      platform: string | null
      framework: string | null
      anomalyKind: string | null
      severity: string | null
      summary: string | null
      actionTypes: string | null
      payloadJson: string
      ts: Date
    }) => ({
      id: event.id,
      deliveryId: event.deliveryId,
      type: event.type,
      taskId: event.taskId,
      platform: event.platform,
      framework: event.framework,
      anomalyKind: event.anomalyKind,
      severity: event.severity,
      summary: event.summary,
      actionTypes: event.actionTypes,
      payloadJson: event.payloadJson,
      ts: event.ts.toISOString(),
    }))
    const markers = buildRasTraceMarkers(rows, locale)

    const anomalyStatus = deriveAnomalyStatus({ eventCount: events.length })
    const faults = events.map((event: {
      id: string
      anomalyKind: string | null
      type: string
      severity: string | null
      ts: Date
      actionTypes: string | null
      summary: string | null
    }) => {
      const actionTypes = String(event.actionTypes || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      return {
        faultType: event.anomalyKind || event.type || 'unknown',
        severity: event.severity || 'unknown',
        firstOccurredAt: event.ts.toISOString(),
        affectedSpanIds: [] as string[],
        timeline: [
          {
            phase: 'DETECTED',
            eventId: event.id,
            occurredAt: event.ts.toISOString(),
          },
          ...(actionTypes.length
            ? [{
                phase: 'ACTION',
                eventId: event.id,
                occurredAt: event.ts.toISOString(),
                actions: actionTypes,
              }]
            : []),
        ],
        rasAction: actionTypes[0]
          ? { type: actionTypes[0], target: null, success: null }
          : null,
        summary: event.summary || null,
      }
    })

    if (executionSnapshot) {
      const {evidence} = await readTraceExecution(req, {executionId: id})
      if (evidence.snapshot_hash !== executionSnapshot) {
        const fields=['project_id','workspace_id','trace_id','source_namespace','native_trace_id','trace_bucket','incarnation','route_epoch','owner_principal_id']
        const firstIdentity=executionIdentity,firstAliases=firstIdentity?.aliases as Record<string,unknown>|undefined,nextAliases=evidence.manifest.aliases as Record<string,unknown>|undefined
        const sameAliases=firstAliases&&nextAliases&&['task_id','execution_id'].every(key=>typeof firstAliases[key]==='string'&&firstAliases[key]===nextAliases[key])
        const sameIdentity=firstIdentity&&sameAliases&&execution?.id===evidence.execution.id&&execution?.taskId===evidence.execution.taskId&&fields.every(key=>typeof firstIdentity[key]==='string'&&firstIdentity[key]===evidence.manifest[key])
        if(sameIdentity)throw coreReadChanged('Reliability execution source changed')
        throw Object.assign(new Error('Reliability execution identity changed'), {status: 409})
      }
    }
    if (coreEvents) await coreEvents.validate()
    return NextResponse.json({
      executionId: id,
      lifecycleStatus: execution?.finalResult ? 'success' : 'unknown',
      anomalyStatus,
      anomalyCount: events.length,
      markers,
      summary: {
        faultOccurred: events.length > 0 ? true : null,
        faultDetected: events.length > 0,
        mitigationTriggered: faults.some((f: { rasAction: unknown }) => Boolean(f.rasAction)),
        mitigated: faults.some((f: { rasAction: unknown }) => Boolean(f.rasAction)),
        recovered: Boolean(execution?.finalResult),
        finalOutcome: execution?.finalResult ? 'success' : 'unknown',
      },
      faults,
      evaluation: null,
    })
  } catch (error) {
    throw error
  }
}
