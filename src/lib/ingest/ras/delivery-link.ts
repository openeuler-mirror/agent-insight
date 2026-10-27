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

import type { RasTraceMarker, RasRecoveryAction, RasActionResult } from "@/lib/ingest/ras/trace-markers"

export type RasDeliveryLink = {
  markerId: string
  actionType: string
  messageId?: string
}

const SYSTEM_REMINDER_RE = /^\s*<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>\s*$/i

/** Normalize notice/steering body (tests / display); not used for delivery linking. */
export function normalizeRasDeliveryText(raw: string | null | undefined): string {
  let text = String(raw || "").replace(/\r\n/g, "\n").trim()
  const wrapped = text.match(SYSTEM_REMINDER_RE)
  if (wrapped) text = String(wrapped[1] || "").trim()
  return text.replace(/\s+/g, " ")
}

type InteractionLike = {
  messageID?: string | null
  role?: string | null
  content?: string | null
}

/** Roles that are never RAS delivery targets (model / tool output). */
const NON_DELIVERY_ROLES = new Set([
  "assistant",
  "llm",
  "tool",
  "skill",
  "subagent",
  "agent",
])

/**
 * Link RAS recovery deliveries to session interactions by delivery_anchor.message_id only.
 * Any non-model role with a matching messageID qualifies (platform-agnostic).
 */
export function buildRasDeliveryLinks(opts: {
  markers: Array<Pick<RasTraceMarker, "id" | "actionResults" | "actions" | "deliveryMessageIds">>
  interactions: InteractionLike[]
}): Map<string, RasDeliveryLink> {
  const byMessageId = new Map<string, RasDeliveryLink>()

  for (const marker of opts.markers) {
    for (const messageId of marker.deliveryMessageIds || []) {
      if (!byMessageId.has(messageId)) {
        const result = (marker.actionResults || []).find(
          (item) => item.deliveryMessageId === messageId,
        )
        byMessageId.set(messageId, {
          markerId: marker.id,
          actionType: result?.action || "emit_notice",
          messageId,
        })
      }
    }
  }

  const out = new Map<string, RasDeliveryLink>()
  for (const interaction of opts.interactions) {
    const role = String(interaction.role || "").toLowerCase()
    if (NON_DELIVERY_ROLES.has(role)) continue
    const messageId = String(interaction.messageID || "").trim()
    if (!messageId || !byMessageId.has(messageId)) continue
    out.set(messageId, byMessageId.get(messageId)!)
  }
  return out
}

export type InterleavedRasStep =
  | { kind: "action"; action: RasRecoveryAction; index: number }
  | { kind: "result"; result: RasActionResult; index: number }

/** Pair each requested action with the next unused result of the same type. */
export function interleaveRasActions(
  actions: RasRecoveryAction[],
  actionResults: RasActionResult[],
): InterleavedRasStep[] {
  const remaining = [...actionResults]
  const steps: InterleavedRasStep[] = []
  actions.forEach((action, index) => {
    steps.push({ kind: "action", action, index })
    const resultIndex = remaining.findIndex((item) => item.action === action.type)
    if (resultIndex >= 0) {
      const [result] = remaining.splice(resultIndex, 1)
      steps.push({ kind: "result", result, index: resultIndex })
    }
  })
  remaining.forEach((result, index) => {
    steps.push({ kind: "result", result, index })
  })
  return steps
}
