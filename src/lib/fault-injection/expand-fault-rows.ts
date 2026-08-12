import type { FaultItem, FaultSubmode } from '@/lib/fault-injection/types'

export type FaultTableRow = {
  key: string
  fault: FaultItem
  submode: FaultSubmode | null
}

/** Align with dev_agent_ras FaultTable.expandFaultRows: multi-submode → one row each. */
export function expandFaultRows(faults: FaultItem[]): FaultTableRow[] {
  const rows: FaultTableRow[] = []
  for (const fault of faults) {
    const submodes = fault.submodes ?? []
    if (submodes.length > 1) {
      for (const submode of submodes) {
        rows.push({ key: `${fault.id}::${submode.id}`, fault, submode })
      }
      continue
    }
    rows.push({ key: fault.id, fault, submode: submodes[0] || null })
  }
  return rows
}

export function faultSubmodeCaseKey(faultId: string, submodeId?: string | null): string {
  const fault = String(faultId || '').trim()
  const sub = String(submodeId || '').trim()
  return sub ? `${fault}::${sub}` : fault
}
