/** Session-scoped cache for FI fault id → Chinese label. */

let cachedLabels: Record<string, string> | null = null
let inflight: Promise<Record<string, string>> | null = null

export function peekFaultLabelsCache(): Record<string, string> | null {
  return cachedLabels
}

export async function loadFaultLabelsMap(): Promise<Record<string, string>> {
  if (cachedLabels) return cachedLabels
  if (inflight) return inflight
  inflight = fetch('/api/fault-injection/faults')
    .then((r) => r.json())
    .then((data) => {
      const map: Record<string, string> = {}
      for (const row of data.faults || []) {
        const id = String(row.name || row.id || '')
        if (!id) continue
        map[id] = String(row.labelZh || row.label_zh || row.label || id)
      }
      cachedLabels = map
      return map
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
