import type { FiPipelineMarker } from '@/lib/fault-injection/trace-markers'

export type PipelineStep = {
  key: string
  label: string
  done: boolean
  skipped?: boolean
  severity: string
  summary?: string
  detail?: string
  meta?: string
}

const EVAL_REASON_LABELS: Record<string, string> = {
  judge_disabled: '已关闭评判（CLI --no-judge）',
  judge_skipped: 'Insight 评判已跳过',
  fault_not_activated: '故障未注入，跳过评判',
}

function pipelineStageKey(marker: FiPipelineMarker): string | null {
  if (marker.kind === 'fault_activation') {
    const label = marker.label.toLowerCase()
    if (label.includes('requested')) return 'fault_requested'
    if (label.includes('started')) return 'fault_started'
    if (label.includes('completed')) return 'fault_completed'
    return null
  }
  if (marker.kind === 'evaluation') {
    const label = marker.label.toLowerCase()
    if (label.includes('skipped')) return 'eval_skipped'
    if (label.includes('failed')) return 'eval_failed'
    if (label.includes('completed')) return 'eval_completed'
    if (label.includes('started')) return 'eval_started'
    return null
  }
  return null
}

function markerSkill(marker: FiPipelineMarker): string | undefined {
  const payload = marker.payload
  if (!payload) return undefined
  for (const key of ['faultSkill', 'skill'] as const) {
    const skill = payload[key]
    if (typeof skill === 'string' && skill.trim()) return skill
  }
  return undefined
}

function markerCallId(marker: FiPipelineMarker): string | undefined {
  const payload = marker.payload
  if (!payload) return undefined
  const callID = payload.callID ?? payload.callId
  return typeof callID === 'string' && callID.trim() ? callID : undefined
}

function formatMarkerDetail(
  marker: FiPipelineMarker,
  stageKey: string,
): { summary?: string; detail?: string; meta?: string; severity: string } {
  const payload = marker.payload && typeof marker.payload === 'object' ? marker.payload : {}
  const skill = markerSkill(marker)
  const callID = markerCallId(marker)
  const severity = marker.severity || 'info'

  if (stageKey === 'fault_requested') {
    const instruction =
      typeof payload.instruction === 'string' && payload.instruction.trim()
        ? payload.instruction
        : undefined
    return {
      severity,
      meta: skill,
      summary: skill ? `请求加载 skill: ${skill}` : '已向 system 写入故障注入请求',
      detail: instruction,
    }
  }
  if (stageKey === 'fault_started') {
    return {
      severity,
      meta: skill,
      summary: skill ? `开始加载 skill: ${skill}` : '故障注入开始（skill 工具已调用）',
      detail: [
        skill ? `skill: ${skill}` : null,
        callID ? `callID: ${callID}` : null,
        typeof payload.sessionID === 'string' ? `session: ${payload.sessionID}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  if (stageKey === 'fault_completed') {
    return {
      severity,
      meta: skill,
      summary: skill ? `skill 加载完成: ${skill}` : '故障注入完成',
      detail: [
        skill ? `skill: ${skill}` : null,
        callID ? `callID: ${callID}` : null,
        typeof payload.sessionID === 'string' ? `session: ${payload.sessionID}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  if (stageKey === 'eval_skipped') {
    const reason = typeof payload.reason === 'string' ? payload.reason : ''
    const reasonLabel = EVAL_REASON_LABELS[reason] || reason || '评判已跳过'
    return {
      severity: 'info',
      summary: reasonLabel,
      detail: reason ? `reason: ${reason}\n${reasonLabel}` : reasonLabel,
    }
  }
  if (stageKey === 'eval_started') {
    return {
      severity,
      summary: '评判已开始',
      detail: [
        typeof payload.judge_agent === 'string' ? `judge_agent: ${payload.judge_agent}` : null,
        typeof payload.judge_model === 'string' ? `judge_model: ${payload.judge_model}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  if (stageKey === 'eval_completed') {
    const outcome = typeof payload.outcome === 'string' ? payload.outcome : undefined
    const reason = typeof payload.reason === 'string' ? payload.reason : undefined
    return {
      severity,
      summary: outcome ? `评判完成 · ${outcome}` : '评判完成',
      detail: [outcome ? `outcome: ${outcome}` : null, reason ? `reason: ${reason}` : null]
        .filter(Boolean)
        .join('\n'),
    }
  }
  if (stageKey === 'eval_failed') {
    const error = typeof payload.error === 'string' ? payload.error : undefined
    return {
      severity: 'critical',
      summary: '评判失败',
      detail: error || 'evaluation.failed',
    }
  }
  return { severity }
}

/** Build fixed 4-node pipeline; pending steps stay hollow until markers arrive. */
export function buildMarkerPipeline(markers: FiPipelineMarker[]): PipelineStep[] {
  const byKey = new Map<string, FiPipelineMarker>()
  for (const marker of markers) {
    const key = pipelineStageKey(marker)
    if (!key || byKey.has(key)) continue
    byKey.set(key, marker)
  }

  const evalKey = byKey.has('eval_failed')
    ? 'eval_failed'
    : byKey.has('eval_completed')
      ? 'eval_completed'
      : byKey.has('eval_skipped')
        ? 'eval_skipped'
        : byKey.has('eval_started')
          ? 'eval_started'
          : null

  const slots: Array<{ key: string; label: string; markerKey: string | null }> = [
    { key: 'fault_requested', label: '故障注入请求', markerKey: 'fault_requested' },
    { key: 'fault_started', label: '故障注入开始', markerKey: 'fault_started' },
    { key: 'fault_completed', label: '故障注入完成', markerKey: 'fault_completed' },
    {
      key: 'evaluation',
      label:
        evalKey === 'eval_failed'
          ? '评判失败'
          : evalKey === 'eval_completed'
            ? '评判完成'
            : evalKey === 'eval_skipped'
              ? '评判已跳过'
              : evalKey === 'eval_started'
                ? '评判开始'
                : '评判',
      markerKey: evalKey,
    },
  ]

  return slots.map((slot) => {
    const marker = slot.markerKey ? byKey.get(slot.markerKey) : undefined
    if (!marker || !slot.markerKey) {
      return {
        key: slot.key,
        label: slot.label,
        done: false,
        severity: 'info',
        summary: '尚未执行',
      }
    }
    const formatted = formatMarkerDetail(marker, slot.markerKey)
    return {
      key: slot.key,
      label: slot.label,
      done: true,
      skipped: slot.markerKey === 'eval_skipped',
      severity: formatted.severity,
      summary: formatted.summary,
      detail: formatted.detail,
      meta: formatted.meta,
    }
  })
}
