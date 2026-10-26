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

import { z } from 'zod'

export const FAULT_OUTCOMES = ['occurred', 'not_occurred'] as const
export const FAULT_CONTAINMENT = [
  'unresolved',
  'recovered',
  'prevented',
  'inconclusive',
] as const

export type FaultOutcome = (typeof FAULT_OUTCOMES)[number]
export type FaultContainmentStatus = (typeof FAULT_CONTAINMENT)[number]

const VALID_PAIRS: ReadonlyArray<readonly [FaultOutcome, FaultContainmentStatus]> = [
  ['occurred', 'unresolved'],
  ['occurred', 'recovered'],
  ['not_occurred', 'prevented'],
  ['not_occurred', 'inconclusive'],
]

export const faultJudgeResultSchema = z.object({
  outcome: z.enum(FAULT_OUTCOMES),
  fault_containment_status: z.enum(FAULT_CONTAINMENT),
  reason: z.string().min(1),
})

export type FaultJudgeResult = z.infer<typeof faultJudgeResultSchema>

export function isValidOutcomeContainmentPair(
  outcome: FaultOutcome,
  containment: FaultContainmentStatus,
): boolean {
  return VALID_PAIRS.some(([o, c]) => o === outcome && c === containment)
}

export function parseFaultJudgeResponse(raw: string): FaultJudgeResult {
  const trimmed = raw.trim()
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error('Judge response missing JSON object')
  }
  const parsedJson = JSON.parse(jsonMatch[0]) as Record<string, unknown>
  if (parsedJson.fault_containment_status === 'no_trace') {
    parsedJson.fault_containment_status = 'inconclusive'
  }
  const parsed = faultJudgeResultSchema.parse(parsedJson)
  if (!isValidOutcomeContainmentPair(parsed.outcome, parsed.fault_containment_status)) {
    throw new Error(
      `Invalid outcome/containment pair: ${parsed.outcome} × ${parsed.fault_containment_status}`,
    )
  }
  return parsed
}

export function skippedJudgeResult(reason: string): FaultJudgeResult {
  return {
    outcome: 'not_occurred',
    fault_containment_status: 'inconclusive',
    reason,
  }
}
