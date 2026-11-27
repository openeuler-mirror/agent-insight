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
