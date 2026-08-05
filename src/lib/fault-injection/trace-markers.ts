import type { RasTraceMarker } from '@/lib/ingest/ras/trace-markers'
import type { RasTimelineEvent } from '@/components/observe/AgentTraceView'

/** FI marker shaped for AgentTraceView `anomalies` + MarkerPipeline. */
export type FiTraceMarker = RasTraceMarker & {
  source: 'fi'
  payload?: Record<string, unknown>
}

export type FiPipelineMarker = {
  id: string
  kind: string
  label: string
  timestamp?: number
  severity?: string
  payload?: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = String(value).trim()
  return text || undefined
}

function toTs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

/** Adapt FI collect markers to RasTraceMarker for AgentTraceView. */
export function buildFiTraceMarkers(rawMarkers: unknown): FiTraceMarker[] {
  if (!Array.isArray(rawMarkers)) return []
  return rawMarkers.flatMap((entry, index) => {
    const row = asRecord(entry)
    if (!row) return []
    const id = asString(row.id) || `fi-marker-${index}`
    const kind = asString(row.kind) || 'fault_activation'
    const label = asString(row.label) || kind
    const severity = asString(row.severity) || (kind.includes('fault') ? 'warning' : 'info')
    const payload = asRecord(row.payload) || {}
    const anchor = asRecord(payload.trace_anchor) || {}
    const callId =
      asString(anchor.call_id) ||
      asString(payload.callID) ||
      asString(payload.callId) ||
      asString(row.callId)
    return [
      {
        id,
        ts: toTs(row.timestamp ?? row.ts),
        kind,
        label,
        severity,
        summary: asString(row.summary) || asString(payload.summary),
        messageId: asString(anchor.message_id) || asString(row.messageId),
        partId: asString(anchor.part_id) || asString(row.partId),
        callId,
        channel: asString(anchor.channel) || 'llm_text',
        deliveryMessageIds: [],
        actions: [],
        actionResults: [],
        source: 'fi' as const,
        payload,
      },
    ]
  })
}

/** Raw markers for MarkerPipeline (keeps full payload). */
export function buildFiPipelineMarkers(rawMarkers: unknown): FiPipelineMarker[] {
  return buildFiTraceMarkers(rawMarkers).map((marker) => ({
    id: marker.id,
    kind: marker.kind,
    label: marker.label,
    timestamp: marker.ts,
    severity: marker.severity,
    payload: marker.payload,
  }))
}

/** FI markers as root-timeline reliability events. */
export function buildFiReliabilityEvents(markers: FiTraceMarker[]): RasTimelineEvent[] {
  return markers.map((marker) => ({
    ts: marker.ts,
    type: marker.kind,
    label: marker.label,
    summary: marker.summary,
    payload: {
      source: 'fi',
      severity: marker.severity,
      messageId: marker.messageId,
      ...(marker.payload || {}),
    },
  }))
}

/** Append / replace Insight judge evaluation markers after server-side judge. */
export function mergeEvaluationMarkers(
  existing: unknown,
  input: {
    skipped: boolean
    outcome?: string | null
    reason?: string | null
    model?: string | null
  },
): unknown[] {
  const base = Array.isArray(existing)
    ? existing.filter((entry) => {
        const row = asRecord(entry)
        if (!row) return true
        return asString(row.kind) !== 'evaluation'
      })
    : []

  const now = Date.now() / 1000
  if (input.skipped) {
    base.push({
      id: `evaluation-skipped-${now}`,
      kind: 'evaluation',
      label: 'Evaluation skipped',
      timestamp: now,
      severity: 'info',
      payload: {
        reason: input.reason || 'judge_skipped',
        model: input.model || null,
      },
    })
    return base
  }

  base.push({
    id: `evaluation-started-${now}`,
    kind: 'evaluation',
    label: 'Evaluation started',
    timestamp: now,
    severity: 'info',
    payload: { judge_model: input.model || null },
  })
  base.push({
    id: `evaluation-completed-${now}`,
    kind: 'evaluation',
    label: 'Evaluation completed',
    timestamp: now + 0.001,
    severity: 'info',
    payload: {
      outcome: input.outcome || null,
      reason: input.reason || null,
      judge_model: input.model || null,
    },
  })
  return base
}
