import { NextResponse } from 'next/server'
import { prisma } from '@/lib/storage/prisma'
import { deriveAnomalyStatus } from '@/lib/reliability/anomaly-status'
import { buildRasTraceMarkers } from '@/lib/ingest/ras/trace-markers'
import type { RasEventRow } from '@/lib/ingest/ras/normalize'

export const dynamic = 'force-dynamic'

/** IF-N14：Trace 可靠性详情（无数据时仍 200 + unknown）。 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ executionId: string }> },
) {
  try {
    const { executionId } = await params
    const id = String(executionId || '').trim()
    if (!id) {
      return NextResponse.json({ error: 'executionId is required' }, { status: 400 })
    }

    const url = new URL(req.url)
    const locale = url.searchParams.get('locale') === 'en' ? 'en' : 'zh'

    const execution = await prisma.execution.findUnique({
      where: { id },
      select: { id: true, taskId: true, finalResult: true },
    })

    const taskId = execution?.taskId || ''
    const events = await prisma.rasAnomalyEvent.findMany({
      where: {
        OR: [
          { executionId: id },
          ...(taskId ? [{ taskId }] : []),
        ],
      },
      orderBy: { ts: 'asc' },
      take: 200,
    })

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
    console.error('[observe reliability GET]', error)
    return NextResponse.json({ error: 'failed to load reliability detail' }, { status: 500 })
  }
}
