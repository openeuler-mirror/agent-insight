export const FAULT_MODE_SUB_LABEL_STORAGE_KEY = 'agent-ras.fault-mode.subLabels.v1'

/** Sub-mode display overrides keyed by catalog submode id (string). */
export type FaultModeSubLabelOverrides = Record<string, string>

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
}

export function loadFaultModeSubLabelOverrides(
  storage: Pick<Storage, 'getItem'> | null = isBrowser() ? window.localStorage : null,
): FaultModeSubLabelOverrides {
  if (!storage) return {}
  try {
    const raw = storage.getItem(FAULT_MODE_SUB_LABEL_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: FaultModeSubLabelOverrides = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === 'string' && key && typeof value === 'string' && value.trim()) {
        out[key] = value.trim()
      }
    }
    return out
  } catch {
    return {}
  }
}

export function saveFaultModeSubLabelOverrides(
  overrides: FaultModeSubLabelOverrides,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = isBrowser() ? window.localStorage : null,
): void {
  if (!storage) return
  const cleaned: FaultModeSubLabelOverrides = {}
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof key === 'string' && key && typeof value === 'string' && value.trim()) {
      cleaned[key] = value.trim()
    }
  }
  if (Object.keys(cleaned).length === 0) {
    storage.removeItem(FAULT_MODE_SUB_LABEL_STORAGE_KEY)
    return
  }
  storage.setItem(FAULT_MODE_SUB_LABEL_STORAGE_KEY, JSON.stringify(cleaned))
}

export function resetFaultModeSubLabel(
  id: string,
  current: FaultModeSubLabelOverrides,
  storage?: Pick<Storage, 'setItem' | 'removeItem'> | null,
): FaultModeSubLabelOverrides {
  const next = { ...current }
  delete next[id]
  saveFaultModeSubLabelOverrides(next, storage)
  return next
}

export function resolveFaultModeSubLabel(
  id: string,
  locale: 'zh' | 'en',
  overrides: FaultModeSubLabelOverrides,
  defaultLabel?: string,
): string {
  const override = overrides[id]
  if (override) return override
  return defaultLabel ?? id
}
