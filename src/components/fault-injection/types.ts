export type FiLocale = 'zh' | 'en'

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

export function faultDisplayName(fault: FaultItem, locale: FiLocale = 'zh'): string {
  if (locale === 'en') return fault.labelEn || fault.label || fault.name
  return fault.labelZh || fault.label || fault.name
}

export function injectionMethodLabel(fault: FaultItem, locale: FiLocale = 'zh'): string {
  if (fault.injectionMethodLabel) return fault.injectionMethodLabel
  if (!fault.injectionMethod || fault.injectionMethod === 'skill_inject') {
    return locale === 'zh' ? 'Skill 注入' : 'Skill inject'
  }
  return fault.injectionMethod
}

type LocaleMap = Record<string, { zh: string; en: string }>

const OUTCOME_I18N: LocaleMap = {
  occurred: { zh: '注入成功', en: 'Occurred' },
  not_occurred: { zh: '注入未发生', en: 'Not occurred' },
  skipped: { zh: '跳过', en: 'Skipped' },
}

const CONTAINMENT_I18N: LocaleMap = {
  unresolved: { zh: '未恢复', en: 'Unresolved' },
  recovered: { zh: '已恢复', en: 'Recovered' },
  prevented: { zh: '已阻断', en: 'Prevented' },
  inconclusive: { zh: '证据不足', en: 'Inconclusive' },
  no_trace: { zh: '证据不足', en: 'Inconclusive' },
}

const RUN_STATUS_I18N: LocaleMap = {
  queued: { zh: '排队中', en: 'Queued' },
  collecting: { zh: '注入执行中', en: 'Injecting' },
  judging: { zh: '评判中', en: 'Judging' },
  completed: { zh: '运行完成', en: 'Completed' },
  judge_skipped: { zh: '评判跳过', en: 'Judge skipped' },
  failed: { zh: '失败', en: 'Failed' },
  stopped: { zh: '已停止', en: 'Stopped' },
}

/** @deprecated Prefer outcomeLabel(value, locale) */
export const OUTCOME_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(OUTCOME_I18N).map(([k, v]) => [k, v.zh]),
)

/** @deprecated Prefer containmentLabel(value, locale) */
export const CONTAINMENT_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(CONTAINMENT_I18N).map(([k, v]) => [k, v.zh]),
)

/** @deprecated Prefer fiRunStatusLabel(value, locale) */
export const RUN_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  Object.entries(RUN_STATUS_I18N).map(([k, v]) => [k, v.zh]),
)

function pickLocaleLabel(map: LocaleMap, value: string, locale: FiLocale): string {
  return map[value]?.[locale] ?? value
}

export function outcomeLabel(value?: string | null, locale: FiLocale = 'zh'): string {
  if (!value) return '—'
  return pickLocaleLabel(OUTCOME_I18N, value, locale)
}

export function containmentLabel(value?: string | null, locale: FiLocale = 'zh'): string {
  if (!value) return '—'
  return pickLocaleLabel(CONTAINMENT_I18N, value, locale)
}

export function fiRunStatusLabel(value?: string | null, locale: FiLocale = 'zh'): string {
  if (!value) return '—'
  return pickLocaleLabel(RUN_STATUS_I18N, value, locale)
}

export function labelMap(map: Record<string, string>, value?: string | null): string {
  if (!value) return '—'
  return map[value] ?? value
}
