import type { AgentEvent } from "@/lib/engine/observability/agent-trace"
import { rasKindLabel, type RasEventRow } from "@/lib/ingest/ras/normalize"

export interface RasRecoveryAction {
  type: string
  message?: string
}

export interface RasActionResult {
  action: string
  ok: boolean
  channel?: string
  error?: string
  message?: string
  ts: number
  deliveryMessageId?: string
  deliveryPartId?: string
  deliveryChannel?: string
}

export interface RasTraceMarker {
  id: string
  ts: number
  kind: string
  label: string
  severity: string
  summary?: string
  messageId?: string
  partId?: string
  callId?: string
  channel?: string
  /** Message ids of notice/steering deliveries for this anomaly. */
  deliveryMessageIds: string[]
  actions: RasRecoveryAction[]
  actionResults: RasActionResult[]
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function asString(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = String(value).trim()
  return text || undefined
}

function parsePayload(row: RasEventRow): JsonRecord {
  try {
    return asRecord(JSON.parse(row.payloadJson || "{}")) || {}
  } catch {
    return {}
  }
}

function traceAnchor(payload: JsonRecord): JsonRecord {
  return asRecord(payload.trace_anchor) || {}
}

function anchorKey(anchor: JsonRecord): string | null {
  const callId = asString(anchor.call_id)
  if (callId) return `call:${callId}`
  const messageId = asString(anchor.message_id)
  const partId = asString(anchor.part_id)
  if (partId) return `part:${messageId || ""}:${partId}`
  if (messageId) return `message:${messageId}:${asString(anchor.channel) || ""}`
  return null
}

function recoveryActions(row: RasEventRow, payload: JsonRecord): RasRecoveryAction[] {
  const actions = Array.isArray(payload.actions)
    ? payload.actions.flatMap((entry) => {
        const action = asRecord(entry)
        if (!action) return []
        const type = asString(action.type)
        if (!type) return []
        const message = asString(action.message)
        return [{ type, ...(message ? { message } : {}) }]
      })
    : []
  if (actions.length) return actions
  return String(row.actionTypes || "")
    .split(",")
    .map(type => type.trim())
    .filter(Boolean)
    .map(type => ({ type }))
}

function deliveryAnchor(payload: JsonRecord): JsonRecord {
  return asRecord(payload.delivery_anchor) || {}
}

export function buildRasTraceMarkers(
  rows: RasEventRow[],
  locale: "zh" | "en",
): RasTraceMarker[] {
  const resultRows = rows
    .filter(row => row.type === "action_result")
    .map(row => {
      const payload = parsePayload(row)
      const delivery = deliveryAnchor(payload)
      return {
        key: anchorKey(traceAnchor(payload)),
        action: asString(payload.action) || row.actionTypes || "action",
        ok: Boolean(payload.ok),
        channel: asString(payload.channel),
        error: asString(payload.error),
        message: asString(payload.message),
        deliveryMessageId: asString(delivery.message_id),
        deliveryPartId: asString(delivery.part_id),
        deliveryChannel: asString(delivery.channel),
        ts: new Date(row.ts).getTime(),
      }
    })

  const drafts = rows
    .filter(row => row.type === "anomaly")
    .map(row => {
      const payload = parsePayload(row)
      const anchor = traceAnchor(payload)
      const key = anchorKey(anchor)
      const kind = row.anomalyKind || asString(payload.kind) || "unknown"
      return {
        key,
        marker: {
          id: row.id,
          ts: new Date(row.ts).getTime(),
          kind,
          label: rasKindLabel(kind, locale),
          severity: row.severity || asString(payload.severity) || "low",
          summary: row.summary || asString(payload.summary),
          messageId: asString(anchor.message_id),
          partId: asString(anchor.part_id),
          callId: asString(anchor.call_id),
          channel: asString(anchor.channel),
          deliveryMessageIds: [],
          actions: recoveryActions(row, payload),
          actionResults: [],
        } satisfies RasTraceMarker,
      }
    })
    .sort((a, b) => a.marker.ts - b.marker.ts)

  return drafts.map((draft, index) => {
    const nextSameAnchor = drafts
      .slice(index + 1)
      .find(candidate => candidate.key && candidate.key === draft.key)
    const upperBound = nextSameAnchor?.marker.ts ?? draft.marker.ts + 60_000
    const actionResults = draft.key
      ? resultRows
          .filter(result => (
            result.key === draft.key
            && result.ts >= draft.marker.ts
            && result.ts < upperBound
          ))
          .map(result => ({
            action: result.action,
            ok: result.ok,
            channel: result.channel,
            error: result.error,
            message: result.message,
            ts: result.ts,
            deliveryMessageId: result.deliveryMessageId,
            deliveryPartId: result.deliveryPartId,
            deliveryChannel: result.deliveryChannel,
          }))
      : []
    const deliveryMessageIds = [
      ...new Set(
        actionResults
          .map(result => result.deliveryMessageId)
          .filter((id): id is string => Boolean(id)),
      ),
    ]
    return { ...draft.marker, actionResults, deliveryMessageIds }
  })
}

function partMatchesEvent(event: AgentEvent, partId: string, channel?: string): boolean {
  const part = (event.interaction.parts || []).find(item => item.id === partId)
  if (!part) return false
  if (channel?.startsWith("llm_")) return event.kind === "llm"
  if (channel === "tool_call") {
    return (
      event.kind === "tool"
      || event.kind === "skill"
      || event.kind === "task"
    ) && Boolean(event.toolCallId && part.callID === event.toolCallId)
  }
  if (part.type === "reasoning" || part.type === "text") return event.kind === "llm"
  if (part.callID && event.toolCallId) return part.callID === event.toolCallId
  return false
}

export function findRasMarkersForEvent(
  event: AgentEvent,
  markers: RasTraceMarker[],
): RasTraceMarker[] {
  const messageId = event.interaction.messageID
  return markers.filter(marker => {
    if (messageId && marker.deliveryMessageIds.includes(messageId)) {
      return event.kind === "ras" || event.kind === "user"
    }
    if (marker.callId) return marker.callId === event.toolCallId
    if (marker.partId) return partMatchesEvent(event, marker.partId, marker.channel)
    if (!marker.messageId || marker.messageId !== messageId) return false
    if (marker.channel?.startsWith("llm_")) return event.kind === "llm"
    if (marker.channel === "tool_call") {
      return event.kind === "tool" || event.kind === "skill" || event.kind === "task"
    }
    return event.kind === "llm"
  })
}
