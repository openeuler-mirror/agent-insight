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

import type { RasTraceMarker } from '@/lib/ingest/ras/trace-markers'

/** FI marker shaped for AgentTraceView `anomalies` + MarkerPipeline. */
export type FiTraceMarker = RasTraceMarker & {
  source: 'fi'
  payload?: Record<string, unknown>
}

export type FiPipelineMarker = {
  id: string
  kind: string
  label: string
  timestamp?: number
  severity?: string
  payload?: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | undefined {
  if (value == null) return undefined
  const text = String(value).trim()
  return text || undefined
}

function toTs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

/** Adapt FI collect markers to RasTraceMarker for AgentTraceView. */
export function buildFiTraceMarkers(rawMarkers: unknown): FiTraceMarker[] {
  if (!Array.isArray(rawMarkers)) return []
  return rawMarkers.flatMap((entry, index) => {
    const row = asRecord(entry)
    if (!row) return []
    const id = asString(row.id) || `fi-marker-${index}`
    const kind = asString(row.kind) || 'fault_activation'
    const label = asString(row.label) || kind
    const severity = asString(row.severity) || (kind.includes('fault') ? 'warning' : 'info')
    const payload = asRecord(row.payload) || {}
    const anchor = asRecord(payload.trace_anchor) || {}
    const callId =
      asString(anchor.call_id) ||
      asString(payload.callID) ||
      asString(payload.callId) ||
      asString(row.callId)
    return [
      {
        id,
        ts: toTs(row.timestamp ?? row.ts),
        kind,
        label,
        severity,
        summary: asString(row.summary) || asString(payload.summary),
        messageId: asString(anchor.message_id) || asString(row.messageId),
        partId: asString(anchor.part_id) || asString(row.partId),
        callId,
        channel: asString(anchor.channel) || 'llm_text',
        deliveryMessageIds: [],
        actions: [],
        actionResults: [],
        source: 'fi' as const,
        payload,
      },
    ]
  })
}

/** Raw markers for MarkerPipeline (keeps full payload). */
export function buildFiPipelineMarkers(rawMarkers: unknown): FiPipelineMarker[] {
  return buildFiTraceMarkers(rawMarkers).map((marker) => ({
    id: marker.id,
    kind: marker.kind,
    label: marker.label,
    timestamp: marker.ts,
    severity: marker.severity,
    payload: marker.payload,
  }))
}
