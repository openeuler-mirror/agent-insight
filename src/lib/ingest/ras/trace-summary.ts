/**
 * OpenCode (and similar agents) often prepend mode directives as the first
 * "user" message. Those must not become the /agent-ras/trace list summary,
 * or FI runs like thinking-dead-loop look like unrelated search sessions.
 */
const MODE_PREAMBLE_RE = /^\s*\[(?:search|analyze|plan|build|implement)-mode\]/i

export function isAgentModePreamble(text: string | null | undefined): boolean {
  if (!text) return false
  return MODE_PREAMBLE_RE.test(text)
}

/** Prefer anomaly text, then a non-mode query, then session label (e.g. FI skill title). */
export function pickReliabilityTraceSummary(opts: {
  anomalySummary?: string | null
  executionQuery?: string | null
  sessionLabel?: string | null
}): string | null {
  const anomaly = opts.anomalySummary?.trim()
  if (anomaly) return anomaly

  const query = opts.executionQuery?.trim() || null
  const label = opts.sessionLabel?.trim() || null

  if (query && !isAgentModePreamble(query)) return query
  if (label) return label
  return query
}

/** First real user task text for FI Execution.query — skip mode preambles. */
export function pickFiUserQuery(
  interactions: unknown[] | null | undefined,
  fault: string,
): string {
  for (const item of interactions || []) {
    if (!item || typeof item !== "object") continue
    const row = item as Record<string, unknown>
    if (row.role !== "user") continue
    const content = row.content
    if (typeof content !== "string" || !content.trim()) continue
    if (isAgentModePreamble(content)) continue
    return content.trim().slice(0, 4000)
  }
  const faultName = typeof fault === "string" && fault.trim() ? fault.trim() : "fault"
  return `FI ${faultName}`
}
