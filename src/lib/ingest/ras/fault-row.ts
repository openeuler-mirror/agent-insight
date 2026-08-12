import type { RasTraceMarker } from "@/lib/ingest/ras/trace-markers"

export type RasFaultOpRole = "abort" | "recover"

export type RasFaultOpTag = {
  type: string
  role: RasFaultOpRole
}

/** Per-anomaly recovery outcome for the detail strip (aligned with list-page store). */
export type RasFaultRowOutcome = "success" | "failed" | "unknown" | "none"

export function rasOpRole(type: string): RasFaultOpRole {
  return type === "abort_stream" ? "abort" : "recover"
}

/** Deduped action type tags in first-seen order; message bodies stay out of the row. */
export function buildRasFaultOpTags(marker: Pick<RasTraceMarker, "actions">): RasFaultOpTag[] {
  const seen = new Set<string>()
  const tags: RasFaultOpTag[] = []
  for (const action of marker.actions || []) {
    const type = String(action.type || "").trim()
    if (!type || seen.has(type)) continue
    seen.add(type)
    tags.push({ type, role: rasOpRole(type) })
  }
  return tags
}

export function rasFaultRowOutcome(
  marker: Pick<RasTraceMarker, "actions" | "actionResults">,
): RasFaultRowOutcome {
  const actions = marker.actions || []
  const results = marker.actionResults || []
  if (!actions.length) return "none"
  if (!results.length) return "unknown"
  if (results.some((result) => result.ok === false)) return "failed"
  return "success"
}
