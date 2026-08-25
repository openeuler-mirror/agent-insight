/**
 * ExperimentCase 上的 FI 元数据：独立列优先，兼容历史塞进 evaluatorContextJson 的脏数据。
 */
import {
  parseStoredEvaluatorCaseContext,
  type StoredEvaluatorContextResult,
} from '@/lib/evaluators/evaluator-case-context'

export type LegacyFiFromContext = {
  faultInjectionType: string | null
  fiTaskId: string | null
  fiRunId: string | null
  values: Record<string, unknown> | null
  /** 仅有 FI 字段、不是合法 EvaluatorCaseContextV1 */
  isFiOnlyPollution: boolean
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

/** 从历史污染的 evaluatorContextJson 抽出 FI 字段（读路径兼容）。 */
export function extractLegacyFiFromEvaluatorContextJson(
  raw: string | null | undefined,
): LegacyFiFromContext {
  const empty: LegacyFiFromContext = {
    faultInjectionType: null,
    fiTaskId: null,
    fiRunId: null,
    values: null,
    isFiOnlyPollution: false,
  }
  if (!raw || !raw.trim()) return empty
  let parsed: Record<string, unknown>
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return empty
    parsed = value as Record<string, unknown>
  } catch {
    return empty
  }

  const values =
    parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values)
      ? (parsed.values as Record<string, unknown>)
      : null
  const faultInjectionType =
    asNonEmptyString(values?.fault_injection_type) ||
    asNonEmptyString(parsed.fault_injection_type)
  const fiTaskId = asNonEmptyString(parsed.fiTaskId)
  const fiRunId = asNonEmptyString(parsed.fiRunId)
  const hasFiMeta = Boolean(faultInjectionType || fiTaskId || fiRunId || values)
  const hasV1Shape =
    parsed.schemaVersion === 1 && Object.prototype.hasOwnProperty.call(parsed, 'availableTools')
  return {
    faultInjectionType,
    fiTaskId,
    fiRunId,
    values,
    isFiOnlyPollution: hasFiMeta && !hasV1Shape,
  }
}

export function resolveCaseFaultInjectionType(caseRow: {
  faultInjectionType?: string | null
  evaluatorContextJson?: string | null
}): string {
  const fromCol = asNonEmptyString(caseRow.faultInjectionType)
  if (fromCol) return fromCol
  return extractLegacyFiFromEvaluatorContextJson(caseRow.evaluatorContextJson).faultInjectionType || ''
}

/**
 * 解析 ExperimentCase.evaluatorContextJson：
 * 历史 FI-only 污染不再报虚假 evaluatorContextError。
 */
export function parseExperimentCaseEvaluatorContext(
  raw: string | null | undefined,
): StoredEvaluatorContextResult {
  const result = parseStoredEvaluatorCaseContext(raw)
  if (!result.error) return result
  const legacy = extractLegacyFiFromEvaluatorContextJson(raw)
  if (legacy.isFiOnlyPollution) {
    return { context: null, error: null }
  }
  return result
}
