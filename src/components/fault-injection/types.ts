export type FaultSubmode = {
  id: string
  name: string
  description?: string
  visible?: boolean
}

export type FaultItem = {
  id: string
  name: string
  skillName?: string
  description?: string
  injectionMethod?: string
  injectionMethodLabel?: string
  label?: string
  labelZh?: string
  labelEn?: string
  platforms?: string[] | null
  submodes?: FaultSubmode[]
}

export type ProgressCounts = {
  total: number
  queued: number
  running: number
  completed: number
  failed: number
  judge_skipped?: number
  stopped?: number
}

export type PlatformInfo = {
  id: string
  label: string
  readiness: 'ready' | 'not_ready' | 'unknown'
  preflight_errors?: string[]
  executable?: string | null
}

export type PlatformOption = {
  id: string
  label?: string
}

function pickString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (value == null) continue
    const text = String(value).trim()
    if (text) return text
  }
  return undefined
}

export function normalizeFault(raw: Record<string, unknown>): FaultItem {
  const name = pickString(raw, 'name', 'id') || ''
  const submodes = Array.isArray(raw.submodes)
    ? (raw.submodes as Array<Record<string, unknown>>)
        .map((s, index) => {
          const id =
            pickString(s, 'id') ||
            (pickString(s, 'name') ? String(index + 1) : '') ||
            String(index + 1)
          const subName = pickString(s, 'name', 'id') || id
          return {
            id,
            name: subName,
            description: pickString(s, 'description'),
            visible: s.visible !== false,
          }
        })
        .filter((s) => s.visible !== false && Boolean(s.id))
    : []

  const labelZh = pickString(raw, 'labelZh', 'label_zh', 'label') || name
  const labelEn = pickString(raw, 'labelEn', 'label_en') || name
  const injectionMethod =
    pickString(raw, 'injectionMethod', 'injection_method') || 'skill_inject'

  return {
    id: name,
    name,
    skillName: pickString(raw, 'skillName', 'skill_name'),
    description: pickString(raw, 'description'),
    injectionMethod,
    injectionMethodLabel: pickString(
      raw,
      'injectionMethodLabel',
      'injection_method_label',
    ),
    label: labelZh,
    labelZh,
    labelEn,
    platforms: Array.isArray(raw.platforms) ? (raw.platforms as string[]) : null,
    submodes,
  }
}

export function faultDisplayName(fault: FaultItem): string {
  return fault.labelZh || fault.label || fault.name
}

export function injectionMethodLabel(fault: FaultItem): string {
  if (fault.injectionMethodLabel) return fault.injectionMethodLabel
  if (!fault.injectionMethod || fault.injectionMethod === 'skill_inject') return 'Skill 注入'
  return fault.injectionMethod
}

export const OUTCOME_LABELS: Record<string, string> = {
  occurred: '注入成功',
  not_occurred: '注入未发生',
  skipped: '跳过',
}

export const CONTAINMENT_LABELS: Record<string, string> = {
  unresolved: '未恢复',
  recovered: '已恢复',
  prevented: '已阻断',
  // Insufficient containment evidence — not "missing execution trajectory".
  inconclusive: '证据不足',
  // Legacy stored results (pre-rename).
  no_trace: '证据不足',
}

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  collecting: '采集中',
  judging: '评判中',
  completed: '运行完成',
  judge_skipped: '评判跳过',
  failed: '失败',
  stopped: '已停止',
}

export function labelMap(map: Record<string, string>, value?: string | null): string {
  if (!value) return '—'
  return map[value] ?? value
}
