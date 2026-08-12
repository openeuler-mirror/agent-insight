export type RasTraceTimeSortDir = "asc" | "desc"

/** Sort reliability list rows by `latestTs`. Invalid timestamps sink to the end. */
export function sortRasTracesByTime<T extends { latestTs: string }>(
  traces: T[],
  dir: RasTraceTimeSortDir = "desc",
): T[] {
  const sign = dir === "asc" ? 1 : -1
  return [...traces].sort((a, b) => {
    const ta = Date.parse(a.latestTs)
    const tb = Date.parse(b.latestTs)
    const aOk = Number.isFinite(ta)
    const bOk = Number.isFinite(tb)
    if (!aOk && !bOk) return 0
    if (!aOk) return 1
    if (!bOk) return -1
    if (ta === tb) return 0
    return ta < tb ? -sign : sign
  })
}
