import type { RasFaultModeId } from '@/lib/ingest/ras/fault-mode-catalog'
import { RAS_FAULT_MODE_CATALOG } from '@/lib/ingest/ras/fault-mode-catalog'

export const FAULT_MODE_SUB_LABEL_STORAGE_KEY = 'agent-ras.fault-mode.subLabels.v1'

export type FaultModeSubLabelOverrides = Partial<Record<RasFaultModeId, string>>

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
    for (const item of RAS_FAULT_MODE_CATALOG) {
      const v = (parsed as Record<string, unknown>)[item.id]
      if (typeof v === 'string' && v.trim()) out[item.id] = v.trim()
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
  for (const item of RAS_FAULT_MODE_CATALOG) {
    const v = overrides[item.id]
    if (typeof v === 'string' && v.trim()) cleaned[item.id] = v.trim()
  }
  if (Object.keys(cleaned).length === 0) {
    storage.removeItem(FAULT_MODE_SUB_LABEL_STORAGE_KEY)
    return
  }
  storage.setItem(FAULT_MODE_SUB_LABEL_STORAGE_KEY, JSON.stringify(cleaned))
}

export function resetFaultModeSubLabel(
  id: RasFaultModeId,
  current: FaultModeSubLabelOverrides,
  storage?: Pick<Storage, 'setItem' | 'removeItem'> | null,
): FaultModeSubLabelOverrides {
  const next = { ...current }
  delete next[id]
  saveFaultModeSubLabelOverrides(next, storage)
  return next
}

export function resolveFaultModeSubLabel(
  id: RasFaultModeId,
  locale: 'zh' | 'en',
  overrides: FaultModeSubLabelOverrides,
): string {
  const override = overrides[id]
  if (override) return override
  const item = RAS_FAULT_MODE_CATALOG.find((row) => row.id === id)
  return item ? item.subMode[locale] : id
}
