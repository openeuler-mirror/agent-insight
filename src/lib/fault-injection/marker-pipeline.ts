import type { FiPipelineMarker } from '@/lib/fault-injection/trace-markers'

export type FiPipelineLocale = 'zh' | 'en'

const OUTCOME_LABELS: Record<FiPipelineLocale, Record<string, string>> = {
  zh: {
    occurred: '注入成功',
    not_occurred: '注入未发生',
    skipped: '跳过',
  },
  en: {
    occurred: 'Occurred',
    not_occurred: 'Not occurred',
    skipped: 'Skipped',
  },
}

function outcomeLabel(value: string | undefined, locale: FiPipelineLocale): string | undefined {
  if (!value) return undefined
  return OUTCOME_LABELS[locale][value] ?? value
}

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

const EVAL_REASON_LABELS: Record<FiPipelineLocale, Record<string, string>> = {
  zh: {
    judge_skipped: 'Insight 评判已跳过',
    fault_not_activated: '故障未注入，跳过评判',
  },
  en: {
    judge_skipped: 'Insight judge skipped',
    fault_not_activated: 'Fault not activated; judge skipped',
  },
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
  locale: FiPipelineLocale,
): { summary?: string; detail?: string; meta?: string; severity: string } {
  const payload = marker.payload && typeof marker.payload === 'object' ? marker.payload : {}
  const skill = markerSkill(marker)
  const callID = markerCallId(marker)
  const severity = marker.severity || 'info'
  const zh = locale === 'zh'

  if (stageKey === 'fault_requested') {
    const instruction =
      typeof payload.instruction === 'string' && payload.instruction.trim()
        ? payload.instruction
        : undefined
    return {
      severity,
      meta: skill,
      summary: skill
        ? zh
          ? `请求加载 skill: ${skill}`
          : `Requested skill load: ${skill}`
        : zh
          ? '已向 system 写入故障注入请求'
          : 'Fault-injection request written to system',
      detail: instruction,
    }
  }
  if (stageKey === 'fault_started') {
    return {
      severity,
      meta: skill,
      summary: skill
        ? zh
          ? `开始加载 skill: ${skill}`
          : `Started skill load: ${skill}`
        : zh
          ? '故障注入开始（skill 工具已调用）'
          : 'Fault injection started (skill tool invoked)',
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
      summary: skill
        ? zh
          ? `skill 加载完成: ${skill}`
          : `Skill load completed: ${skill}`
        : zh
          ? '故障注入完成'
          : 'Fault injection completed',
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
    const reasonLabel =
      EVAL_REASON_LABELS[locale][reason] ||
      reason ||
      (zh ? '评判已跳过' : 'Judge skipped')
    return {
      severity: 'info',
      summary: reasonLabel,
      detail: reason ? `reason: ${reason}\n${reasonLabel}` : reasonLabel,
    }
  }
  if (stageKey === 'eval_started') {
    return {
      severity,
      summary: zh ? '评判已开始' : 'Judge started',
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
    const labeled = outcomeLabel(outcome, locale)
    return {
      severity,
      summary: labeled
        ? zh
          ? `评判完成 · ${labeled}`
          : `Judge completed · ${labeled}`
        : zh
          ? '评判完成'
          : 'Judge completed',
      detail: [
        labeled ? (zh ? `注入结果: ${labeled}` : `Outcome: ${labeled}`) : null,
        reason ? (zh ? `原因: ${reason}` : `Reason: ${reason}`) : null,
      ]
        .filter(Boolean)
        .join('\n'),
    }
  }
  if (stageKey === 'eval_failed') {
    const error = typeof payload.error === 'string' ? payload.error : undefined
    return {
      severity: 'critical',
      summary: zh ? '评判失败' : 'Judge failed',
      detail: error || 'evaluation.failed',
    }
  }
  return { severity }
}

function evalSlotLabel(evalKey: string | null, locale: FiPipelineLocale): string {
  const zh = locale === 'zh'
  if (evalKey === 'eval_failed') return zh ? '评判失败' : 'Judge failed'
  if (evalKey === 'eval_completed') return zh ? '评判完成' : 'Judge completed'
  if (evalKey === 'eval_skipped') return zh ? '评判已跳过' : 'Judge skipped'
  if (evalKey === 'eval_started') return zh ? '评判开始' : 'Judge started'
  return zh ? '评判' : 'Judge'
}

/** Build fixed 4-node pipeline; pending steps stay hollow until markers arrive. */
export function buildMarkerPipeline(
  markers: FiPipelineMarker[],
  locale: FiPipelineLocale = 'zh',
): PipelineStep[] {
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

  const zh = locale === 'zh'
  const slots: Array<{ key: string; label: string; markerKey: string | null }> = [
    {
      key: 'fault_requested',
      label: zh ? '故障注入请求' : 'Injection requested',
      markerKey: 'fault_requested',
    },
    {
      key: 'fault_started',
      label: zh ? '故障注入开始' : 'Injection started',
      markerKey: 'fault_started',
    },
    {
      key: 'fault_completed',
      label: zh ? '故障注入完成' : 'Injection completed',
      markerKey: 'fault_completed',
    },
    {
      key: 'evaluation',
      label: evalSlotLabel(evalKey, locale),
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
        summary: zh ? '尚未执行' : 'Not started',
      }
    }
    const formatted = formatMarkerDetail(marker, slot.markerKey, locale)
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
