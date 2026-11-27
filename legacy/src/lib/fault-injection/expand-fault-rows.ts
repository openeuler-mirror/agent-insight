/*
 * Copyright (c) 2026 Huawei Technologies Co., Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
