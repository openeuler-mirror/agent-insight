/** Session-scoped cache for FI fault id → localized labels + submode names. */

export type FaultLabelsBundle = {
  zh: Record<string, string>
  en: Record<string, string>
  /** faultId → submodeId → display name */
  submodes: Record<string, Record<string, string>>
}

let cached: FaultLabelsBundle | null = null
let inflight: Promise<FaultLabelsBundle> | null = null

export function peekFaultLabelsCache(
  locale: 'zh' | 'en' = 'zh',
): Record<string, string> | null {
  return cached?.[locale] ?? null
}

export function peekSubmodeLabelsCache(
  faultId: string,
): Record<string, string> | null {
  if (!cached) return null
  return cached.submodes[faultId] ?? {}
}

export function resolveSubmodeLabel(
  faultId: string,
  submode: string | null | undefined,
): string | null {
  if (!submode) return null
  const map = cached?.submodes[faultId]
  if (!map) return null
  return map[submode] || map[String(submode).trim()] || null
}

export async function loadFaultLabelsMap(
  locale: 'zh' | 'en' = 'zh',
): Promise<Record<string, string>> {
  const bundle = await loadFaultLabelsBundle()
  return bundle[locale]
}

export async function loadFaultLabelsBundle(): Promise<FaultLabelsBundle> {
  if (cached) return cached
  if (inflight) return inflight
  inflight = fetch('/api/fault-injection/faults')
    .then((r) => r.json())
    .then((data) => {
      const zh: Record<string, string> = {}
      const en: Record<string, string> = {}
      const submodes: Record<string, Record<string, string>> = {}
      for (const row of data.faults || []) {
        const id = String(row.name || row.id || '')
        if (!id) continue
        zh[id] = String(row.labelZh || row.label_zh || row.label || id)
        en[id] = String(row.labelEn || row.label_en || row.label || id)
        const byId: Record<string, string> = {}
        for (const sm of row.submodes || []) {
          const smId = String(sm.id || '').trim()
          const smName = String(sm.name || smId).trim()
          if (!smId) continue
          byId[smId] = smName
          if (smName && smName !== smId) byId[smName] = smName
        }
        submodes[id] = byId
      }
      cached = { zh, en, submodes }
      return cached
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}
