import { randomUUID } from 'crypto'
import {
  buildRasIngestRecord,
  type RasIngestRecord,
} from '@/lib/ingest/ras/normalize'
import { upsertRasIngestRecords } from '@/lib/ingest/ras/store'
import type { CollectPayload } from '@/lib/fault-injection/engine'

/** Map FI skill / fault id → RAS anomalyKind used by 可靠性观测. */
const FAULT_TO_ANOMALY_KIND: Record<string, string> = {
  'thinking-dead-loop': 'llm_thinking_dead_loop',
  'thinking-loop': 'llm_thinking_loop',
  'analysis-paralysis': 'llm_thinking_loop',
  tool_repeat_dead_loop: 'tool_call_loop',
  'tool-repeat-dead-loop': 'tool_call_loop',
}

export function mapFaultToAnomalyKind(fault: string): string {
  const key = fault.trim()
  return FAULT_TO_ANOMALY_KIND[key] || FAULT_TO_ANOMALY_KIND[key.replace(/_/g, '-')] || `fi_${key}`
}

function isStubPayload(payload: CollectPayload): boolean {
  const evidence = payload.injectionEvidence || {}
  const runtime = evidence.runtime
  if (runtime && typeof runtime === 'object' && (runtime as { stub?: boolean }).stub) {
    return true
  }
  return String(payload.taskId || '').startsWith('fi-session-')
}

/**
 * Build RAS ingest rows from a real FI collect payload.
 * Dry-run / stub payloads return [] — never pollute 可靠性观测 with fake anomalies.
 */
export function buildRasRecordsFromFiCollect(input: {
  insightRunId: string
  payload: CollectPayload
  outcome?: string | null
  judgeSkipped?: boolean
}): RasIngestRecord[] {
  if (isStubPayload(input.payload)) return []

  const taskId = input.payload.taskId
  if (!taskId) return []

  const fault = input.payload.fault
  const anomalyKind = mapFaultToAnomalyKind(fault)
  const activated = Boolean(input.payload.faultActivated)
  const ts = input.payload.faultActivatedAt
    ? new Date(input.payload.faultActivatedAt)
    : new Date()

  const records: RasIngestRecord[] = []

  // Always emit an anomaly row when injection was activated so the run
  // appears on /agent-ras/trace (ras-events-only path). Payload is honest:
  // source=fault_injection — not claiming in-process RAS detection.
  if (activated) {
    records.push(
      buildRasIngestRecord({
        taskId,
        deliveryId: randomUUID(),
        type: 'anomaly',
        framework: input.payload.framework || null,
        anomalyKind,
        severity: 'high',
        summary: `故障注入激活：${fault}（Insight run ${input.insightRunId}）`,
        payload: {
          kind: anomalyKind,
          source: 'fault_injection',
          fault,
          insightRunId: input.insightRunId,
          injectionMethod: input.payload.injectionMethod || null,
          faultActivated: true,
          faultActivatedAt: input.payload.faultActivatedAt ?? null,
          markers: input.payload.markers || [],
          injectionEvidence: input.payload.injectionEvidence || {},
          judge: {
            outcome: input.outcome ?? null,
            skipped: Boolean(input.judgeSkipped),
          },
        },
        ts,
        rasSessionKey: `${input.payload.framework || 'fi'}:${taskId}`,
      }),
    )
  }

  return records
}

export async function bridgeFiCollectToRas(input: {
  insightRunId: string
  user: string | null
  payload: CollectPayload
  outcome?: string | null
  judgeSkipped?: boolean
}): Promise<{ written: number; skippedReason?: string }> {
  if (!input.user) {
    return { written: 0, skippedReason: 'missing user — cannot attribute RasAnomalyEvent' }
  }
  const records = buildRasRecordsFromFiCollect(input)
  if (!records.length) {
    return {
      written: 0,
      skippedReason: isStubPayload(input.payload)
        ? 'stub/dry-run payload excluded from reliability observation'
        : input.payload.faultActivated
          ? 'no records built'
          : 'fault not activated — no anomaly event',
    }
  }
  const result = await upsertRasIngestRecords(records, input.user)
  return { written: result.written }
}
