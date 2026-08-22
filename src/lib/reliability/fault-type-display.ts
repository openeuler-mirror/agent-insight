/**
 * 可靠性数据集 / 实验 UI：故障注入类型展示文案。
 * 口径：故障大类 · 故障小类 · 注入方式（无小类则省略小类段）。
 */

export function formatReliabilityFaultTypeDisplay(input: {
  faultLabel?: string | null
  submodeLabel?: string | null
  injectionMethodLabel?: string | null
  fallbackId?: string | null
}): string {
  const fault = String(input.faultLabel || '').trim()
  const submode = String(input.submodeLabel || '').trim()
  const method = String(input.injectionMethodLabel || '').trim()
  const segments = [fault, submode, method].filter(Boolean)
  if (segments.length) return segments.join(' · ')
  return String(input.fallbackId || '').trim()
}

/** 从 case.values + 可选 fault-modes API 行拼展示名。 */
export function formatReliabilityFaultTypeFromCaseValues(
  values: Record<string, unknown> | null | undefined,
  opts?: {
    faultId?: string | null
    apiFaultName?: string | null
    apiInjectionMethodLabel?: string | null
    apiSubmodeLabel?: string | null
  },
): string {
  const v = values || {}
  const faultId = String(opts?.faultId || v.fault_injection_type || '').trim()
  const faultLabel =
    String(opts?.apiFaultName || '').trim()
    || String(v.fault_label || '').trim()
    || faultId
  const submodeLabel =
    String(opts?.apiSubmodeLabel || '').trim()
    || String(v.submode_label || '').trim()
    || ''
  // 有 submode id 但无中文名时，仍展示 id，避免「有小类却不显示」
  const submodeFallback = String(v.submode || '').trim()
  const submodeDisplay = submodeLabel || submodeFallback
  const injectionMethodLabel =
    String(opts?.apiInjectionMethodLabel || '').trim()
    || String(v.injection_method_label || '').trim()
    || ''
  return formatReliabilityFaultTypeDisplay({
    faultLabel,
    submodeLabel: submodeDisplay,
    injectionMethodLabel,
    fallbackId: faultId,
  })
}
