import { listFaultsViaPython } from '@/lib/fault-injection/engine'
import { faultModeSummary, faultSubmodeDescription } from '@/lib/reliability/fault-mode-copy'

export type FaultModeParameter = {
  key: string
  label: string
  type: 'integer' | 'number' | 'string' | 'boolean'
  required?: boolean
  min?: number
  max?: number
  unit?: string
}

export type FaultModeSubmode = {
  id: string
  name: string
  description: string
}

export type FaultModeItem = {
  id: string
  name: string
  description: string
  supportedPlatforms: string[]
  parameters: FaultModeParameter[]
  submodes: FaultModeSubmode[]
  /** Catalog injection_method key (skill_inject / tool_result_tamper / …). */
  injectionMethod?: string
  /** Chinese/EN label from capability_api.yaml via listFaultsViaPython. */
  injectionMethodLabel?: string
}

export const FAULT_MODES_REGISTRY_VERSION = 'fault-modes@2'

type CatalogRow = {
  id?: string
  name?: string
  description?: string
  label?: string
  labelZh?: string
  platforms?: string[] | null
  injectionMethod?: string
  injection_method?: string
  injectionMethodLabel?: string
  injection_method_label?: string
  submodes?: Array<{ id?: string; name?: string; description?: string }>
}

function mapCatalogRow(row: CatalogRow): FaultModeItem {
  const id = String(row.id || row.name || '').trim()
  const name = String(row.labelZh || row.label || row.name || id).trim() || id
  const platforms = Array.isArray(row.platforms)
    ? row.platforms.map((p) => String(p || '').trim()).filter(Boolean)
    : []
  const submodes: FaultModeSubmode[] = Array.isArray(row.submodes)
    ? row.submodes.flatMap((sub) => {
        const key = String(sub?.id || '').trim()
        if (!key) return []
        return [{
          id: key,
          name: String(sub?.name || key).trim() || key,
          description: faultSubmodeDescription(
            id,
            key,
            String(sub?.description || '').trim(),
          ),
        }]
      })
    : []
  const parameters: FaultModeParameter[] = submodes.map((submode) => ({
    key: submode.id,
    label: submode.name,
    type: 'string' as const,
    required: false,
  }))

  const injectionMethod = String(row.injectionMethod || row.injection_method || '').trim() || undefined
  const injectionMethodLabel =
    String(row.injectionMethodLabel || row.injection_method_label || '').trim() || undefined

  return {
    id,
    name,
    description: faultModeSummary(id, String(row.description || '').trim()),
    supportedPlatforms: platforms,
    parameters,
    submodes,
    injectionMethod,
    injectionMethodLabel,
  }
}

/** IF-N16: map FI catalog → fault-modes contract. Unknown platform → empty items. */
export async function listFaultModes(platform?: string | null): Promise<{
  items: FaultModeItem[]
  registryVersion: string
}> {
  const wanted = String(platform || '').trim()
  const rows = (await listFaultsViaPython(wanted || undefined)) as CatalogRow[]
  const items = rows
    .map(mapCatalogRow)
    .filter((item) => item.id)
  return { items, registryVersion: FAULT_MODES_REGISTRY_VERSION }
}

export async function listFaultModeIds(platform?: string | null): Promise<Set<string>> {
  const { items } = await listFaultModes(platform)
  return new Set(items.map((item) => item.id))
}
