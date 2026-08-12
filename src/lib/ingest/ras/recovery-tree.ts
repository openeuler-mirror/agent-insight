import type {
  AgentEvent,
  AgentNode,
  RawInteraction,
} from "@/lib/engine/observability/agent-trace"
import type { RasTraceMarker } from "@/lib/ingest/ras/trace-markers"

function asString(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = String(value).trim()
  return text || undefined
}

function interactionText(interaction: RawInteraction): string {
  const content: unknown = interaction.content
  if (typeof content === "string") return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === "string") return part
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text || "")
        }
        return ""
      })
      .join("")
      .trim()
  }
  return ""
}

/**
 * Align Session interactions to RAS LLM anchors (OpenCode parity).
 * Xiaoo FI often omits messageID on assistant turns while RAS emits
 * `xiaoo-msg-*`; stamp the anomaly message_id onto the best text assistant
 * so recovery-tree can hang after that LLM — not by hardcoding position.
 */
export function alignInteractionsToRasAnchors(
  interactions: RawInteraction[],
  markers: RasTraceMarker[],
): RawInteraction[] {
  if (!interactions.length || !markers.length) return interactions
  const used = new Set(
    interactions
      .map((item) => asString(item.messageID))
      .filter((id): id is string => Boolean(id)),
  )
  const out = interactions.map((item) => ({ ...item }))
  for (const marker of markers) {
    const messageId = asString(marker.messageId)
    if (!messageId || used.has(messageId)) continue
    const channel = asString(marker.channel) || ""
    if (channel && !channel.startsWith("llm")) continue

    let best = -1
    for (let i = 0; i < out.length; i += 1) {
      const item = out[i]
      if (item.role !== "assistant") continue
      if (asString(item.messageID)) continue
      if (!interactionText(item)) continue
      best = i
    }
    if (best < 0) continue
    out[best] = { ...out[best], messageID: messageId }
    used.add(messageId)
  }
  return out
}

/** Drop notice/steering delivery messages so they do not become separate tree rows. */
export function stripDeliveryEventsFromTree(
  node: AgentNode,
  deliveryIds: Set<string>,
  deliveryTexts: Set<string> = new Set(),
): AgentNode {
  if (!deliveryIds.size && !deliveryTexts.size) return node
  return {
    ...node,
    events: node.events.filter((event) => {
      if (event.kind !== "user") return true
      const messageId =
        asString(event.interaction?.messageID)
        || asString((event.interaction as { messageId?: string } | undefined)?.messageId)
        || asString((event.interaction as { id?: string } | undefined)?.id)
      if (messageId && deliveryIds.has(messageId)) return false
      // Fallback when action_result lacked delivery_anchor: exact notice/steering text only.
      if (deliveryTexts.size) {
        const text = interactionText(event.interaction)
        if (text && deliveryTexts.has(text)) return false
      }
      return true
    }),
    children: node.children.map((child) =>
      stripDeliveryEventsFromTree(child, deliveryIds, deliveryTexts),
    ),
  }
}

function collectDeliveryStripTexts(markers: RasTraceMarker[]): Set<string> {
  const texts = new Set<string>()
  for (const marker of markers) {
    for (const result of marker.actionResults || []) {
      const action = String(result.action || "").toLowerCase()
      if (!action.includes("notice") && !action.includes("steering") && !action.includes("steer")) {
        continue
      }
      const message = asString(result.message)
      if (message) texts.add(message)
    }
    for (const action of marker.actions || []) {
      const type = String(action.type || "").toLowerCase()
      if (!type.includes("notice") && !type.includes("steering") && !type.includes("steer")) {
        continue
      }
      const message = asString(action.message)
      if (message) texts.add(message)
    }
  }
  return texts
}

function markerAnchorIndex(events: AgentEvent[], marker: RasTraceMarker): number {
  // Prefer LLM identity (message_id) over tool call_id so thinking-loop markers
  // hang after the looping LLM even if a stale call_id is also present.
  if (marker.messageId) {
    const byMessage = events.findIndex(
      (event) =>
        event.kind !== "ras"
        && asString(event.interaction?.messageID) === marker.messageId,
    )
    if (byMessage >= 0) return byMessage
  }
  if (marker.callId) {
    const byCall = events.findIndex(
      (event) =>
        event.kind !== "ras"
        && (event.toolCallId === marker.callId
          || asString((event.interaction as { tool_calls?: Array<{ id?: string }> })?.tool_calls?.[0]?.id) === marker.callId),
    )
    if (byCall >= 0) return byCall
  }
  return -1
}

function recoverySummary(marker: RasTraceMarker): string {
  const parts: string[] = []
  if (marker.summary) parts.push(marker.summary)
  for (const result of marker.actionResults || []) {
    if (result.message) parts.push(result.message)
  }
  if (!parts.length && marker.actions.length) {
    parts.push(marker.actions.map((action) => action.type).join(", "))
  }
  return parts.join("\n\n") || marker.label
}

export function buildRasRecoveryEvent(marker: RasTraceMarker): AgentEvent {
  const startedAt = marker.ts
  return {
    kind: "ras",
    name: marker.label,
    summary: recoverySummary(marker),
    args: { rasMarkerId: marker.id, kind: marker.kind, severity: marker.severity },
    startedAt,
    completedAt: startedAt,
    interaction: {
      role: "ras",
      content: recoverySummary(marker),
      timestamp: new Date(startedAt).toISOString(),
      messageID: `ras:${marker.id}`,
    },
    interactionIndex: -1,
  }
}

function insertAfterAnchor(
  events: AgentEvent[],
  marker: RasTraceMarker,
  recovery: AgentEvent,
): AgentEvent[] {
  const anchor = markerAnchorIndex(events, marker)
  let placed = recovery
  if (anchor >= 0) {
    // Mid-stream RAS may have wall-clock ts before the LLM interaction's
    // recorded timestamp (xiaoo often stamps completion time). Keep the
    // semantic "after matched LLM" order under chronological sort.
    const anchorStarted = events[anchor].startedAt || 0
    const startedAt = Math.max(placed.startedAt || 0, anchorStarted + 1)
    placed = { ...placed, startedAt, completedAt: startedAt }
    const next = [
      ...events.slice(0, anchor + 1),
      placed,
      ...events.slice(anchor + 1),
    ]
    return next.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
  }
  return [...events, placed].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
}

/**
 * Inject each marker once: prefer the deepest node whose events match the
 * anchor; if nowhere matches, append on the root only (do not duplicate into
 * every child).
 */
function injectMarkersOnce(
  node: AgentNode,
  markers: RasTraceMarker[],
  remaining: Set<string>,
  isRoot: boolean,
): AgentNode {
  const children = node.children.map((child) =>
    injectMarkersOnce(child, markers, remaining, false),
  )

  let events = [...node.events]
  for (const marker of markers) {
    if (!remaining.has(marker.id)) continue
    const anchor = markerAnchorIndex(events, marker)
    if (anchor < 0 && !isRoot) continue
    const recovery = buildRasRecoveryEvent(marker)
    events = insertAfterAnchor(events, marker, recovery)
    remaining.delete(marker.id)
  }

  return { ...node, events, children }
}

/**
 * Ensure each anomaly marker appears as exactly one `kind:'ras'` event.
 * Prefer inserting after the anchored llm/tool/skill event; otherwise append on root.
 */
export function injectRasRecoveryEvents(
  node: AgentNode,
  markers: RasTraceMarker[],
): AgentNode {
  if (!markers.length) return node
  const remaining = new Set(markers.map((marker) => marker.id))
  return injectMarkersOnce(node, markers, remaining, true)
}

export function applyRasRecoveryTree(
  tree: AgentNode,
  markers: RasTraceMarker[],
): AgentNode {
  if (!markers.length) return tree
  const deliveryIds = new Set(
    markers.flatMap((marker) => marker.deliveryMessageIds || []),
  )
  const deliveryTexts = collectDeliveryStripTexts(markers)
  const stripped = stripDeliveryEventsFromTree(tree, deliveryIds, deliveryTexts)
  return injectRasRecoveryEvents(stripped, markers)
}
