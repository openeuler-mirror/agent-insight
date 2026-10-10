import type { DatasetCase } from '@/lib/agent-dataset-model'

export type FaultModeGuideOption = {
  id: string
  name: string
  description?: string
  injectionMethodLabel?: string
  submodes?: Array<{ id: string; name: string; description?: string }>
}

export type FaultModeGuideGroup = {
  id: string
  name: string
  description: string
  injectionMethodLabel: string
  submodes: Array<{ id: string; name: string; description: string }>
}

export function buildFaultModeGuideGroups(
  cases: Array<Pick<DatasetCase, 'values'>>,
  options: FaultModeGuideOption[],
): FaultModeGuideGroup[] {
  const optionById = new Map(options.map((option) => [option.id, option]))
  const groups = new Map<string, FaultModeGuideGroup & { seenSubmodes: Set<string> }>()

  for (const item of cases) {
    const values = item.values || {}
    const faultId = String(values.fault_injection_type || '').trim()
    if (!faultId) continue

    const option = optionById.get(faultId)
    let group = groups.get(faultId)
    if (!group) {
      group = {
        id: faultId,
        name: option?.name || String(values.fault_label || '').trim() || faultId,
        description: option?.description || '',
        injectionMethodLabel:
          option?.injectionMethodLabel
          || String(values.injection_method_label || '').trim(),
        submodes: [],
        seenSubmodes: new Set<string>(),
      }
      groups.set(faultId, group)
    }

    const submodeId = String(values.submode || '').trim()
    const submodeKey = submodeId || '__default__'
    if (group.seenSubmodes.has(submodeKey)) continue
    group.seenSubmodes.add(submodeKey)

    const catalogSubmode = submodeId
      ? option?.submodes?.find((submode) => submode.id === submodeId)
      : undefined
    group.submodes.push({
      id: submodeId,
      name:
        catalogSubmode?.name
        || String(values.submode_label || '').trim()
        || (submodeId || '默认'),
      description:
        catalogSubmode?.description
        || (!submodeId ? option?.description : '')
        || '',
    })
  }

  return [...groups.values()].map((group) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    injectionMethodLabel: group.injectionMethodLabel,
    submodes: group.submodes,
  }))
}
