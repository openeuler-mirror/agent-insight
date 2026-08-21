/**
 * Ensure/sync the builtin reliability dataset from FI fault catalog.
 * Cases follow expandFaultRows (one per submode when multi-submode).
 * Input = composeFaultPrompt (backend SoT). Frontend need not change when catalog grows.
 */
import { randomUUID } from 'crypto'
import {
  createAgentDatasetRecord,
  readUserAgentDatasets,
  updateAgentDatasetRecord,
  type DatasetCase,
} from '@/server/agent_datasets_storage'
import { defaultDatasetSchemaFields } from '@/lib/agent-dataset-model'
import { listFaultsViaPython } from '@/lib/fault-injection/engine'
import { normalizeFault, type FaultItem } from '@/lib/fault-injection/types'
import { composeFaultPrompt } from '@/lib/fault-injection/compose-prompt'
import { expandFaultRows, faultSubmodeCaseKey } from '@/lib/fault-injection/expand-fault-rows'
import { BUILTIN_RELIABILITY_DATASET_NAME } from '@/lib/agent-dataset-builtin'
import { injectionMethodLabel } from '@/lib/fault-injection/types'

export { BUILTIN_RELIABILITY_DATASET_NAME } from '@/lib/agent-dataset-builtin'

function caseKeyFromValues(values: Record<string, unknown> | undefined): string {
  const fault = String(values?.fault_injection_type || '').trim()
  const sub = values?.submode != null ? String(values.submode).trim() : ''
  return faultSubmodeCaseKey(fault, sub || null)
}

export function buildCasesFromCatalog(
  faults: FaultItem[],
  previous: DatasetCase[] = [],
): DatasetCase[] {
  const prevByKey = new Map<string, DatasetCase>()
  for (const item of previous) {
    const key = caseKeyFromValues(item.values)
    if (key && !prevByKey.has(key)) prevByKey.set(key, item)
  }

  return expandFaultRows(faults.filter((fault) => Boolean(fault.id))).map((row) => {
    const fault = row.fault
    const submode = row.submode
    const skillName = String(fault.skillName || fault.name || fault.id).trim() || fault.id
    const input = composeFaultPrompt({
      skillName,
      basePrompt: '',
      submode,
    })
    const key = faultSubmodeCaseKey(fault.id, submode?.id || null)
    const prev = prevByKey.get(key)
    const label = String(fault.labelZh || fault.label || fault.name || fault.id)
    const subLabel = submode?.name ? ` / ${submode.name}` : ''
    const methodLabel = injectionMethodLabel(fault)
    return {
      id: prev?.id || randomUUID(),
      input,
      expectedOutput:
        prev?.expectedOutput
        || `系统应针对故障模式「${label}${subLabel}」产生可观测的可靠性信号（检测/处置/恢复等）。`,
      evaluationFocus: prev?.evaluationFocus || '',
      tags: ['builtin', 'reliability', fault.id, ...(submode?.id ? [`submode:${submode.id}`] : [])],
      trajectory: '',
      values: {
        fault_injection_type: fault.id,
        ...(submode ? { submode: submode.id } : {}),
        fault_label: label,
        ...(submode?.name ? { submode_label: submode.name } : {}),
        ...(fault.injectionMethod ? { injection_method: fault.injectionMethod } : {}),
        ...(methodLabel ? { injection_method_label: methodLabel } : {}),
      },
      source: 'user' as const,
    }
  })
}

export async function ensureBuiltinReliabilityDataset(user: string): Promise<{
  created: boolean
  updated: boolean
  id: string | null
  caseCount: number
}> {
  const u = (user || '').trim()
  if (!u) return { created: false, updated: false, id: null, caseCount: 0 }

  const raw = await listFaultsViaPython()
  const faults = (Array.isArray(raw) ? raw : [])
    .map((row) => normalizeFault(row as Record<string, unknown>))
    .filter((fault) => Boolean(fault.id))

  if (!faults.length) {
    const existing = await readUserAgentDatasets(u)
    const found = existing.find((d) => d.name === BUILTIN_RELIABILITY_DATASET_NAME)
    return { created: false, updated: false, id: found?.id || null, caseCount: found?.cases?.length || 0 }
  }

  const existing = await readUserAgentDatasets(u)
  const found = existing.find((d) => d.name === BUILTIN_RELIABILITY_DATASET_NAME)
  const nowIso = new Date().toISOString()
  const cases = buildCasesFromCatalog(faults, found?.cases || [])
  const description =
    `内置可靠性故障注入评测集。Case 由 FI 故障目录按子模式动态同步（当前 ${cases.length} 条），输入为后端 composeFaultPrompt 生成的注入提示词。`

  if (!found) {
    const id = randomUUID()
    await createAgentDatasetRecord({
      id,
      user: u,
      name: BUILTIN_RELIABILITY_DATASET_NAME,
      description,
      targetAgent: '',
      targetSkill: '',
      tags: ['内置', 'reliability', 'fault-injection'],
      fields: defaultDatasetSchemaFields('reliability'),
      cases,
      datasetKind: 'reliability',
      createdAt: nowIso,
      updatedAt: nowIso,
    })
    return { created: true, updated: false, id, caseCount: cases.length }
  }

  const prevKeys = new Set(
    (found.cases || []).map((c) => caseKeyFromValues(c.values)).filter(Boolean),
  )
  const nextKeys = new Set(cases.map((c) => caseKeyFromValues(c.values)).filter(Boolean))
  const sameSize = prevKeys.size === nextKeys.size
  const sameMembers = sameSize && [...nextKeys].every((key) => prevKeys.has(key))
  const sameInputs =
    sameMembers
    && cases.every((c) => {
      const key = caseKeyFromValues(c.values)
      const prev = (found.cases || []).find((item) => caseKeyFromValues(item.values) === key)
      return prev && prev.input === c.input
    })
  const sameDisplayMeta =
    sameInputs
    && cases.every((c) => {
      const key = caseKeyFromValues(c.values)
      const prev = (found.cases || []).find((item) => caseKeyFromValues(item.values) === key)
      if (!prev) return false
      return (
        String(prev.values?.fault_label || '') === String(c.values?.fault_label || '')
        && String(prev.values?.injection_method_label || '') === String(c.values?.injection_method_label || '')
        && String(prev.values?.submode_label || '') === String(c.values?.submode_label || '')
      )
    })

  if (sameDisplayMeta) {
    return { created: false, updated: false, id: found.id, caseCount: found.cases.length }
  }

  await updateAgentDatasetRecord({
    ...found,
    description,
    fields: found.fields?.length ? found.fields : defaultDatasetSchemaFields('reliability'),
    cases,
    datasetKind: 'reliability',
    updatedAt: nowIso,
  })
  return { created: false, updated: true, id: found.id, caseCount: cases.length }
}
