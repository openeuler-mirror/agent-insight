export type AnomalyStatus = 'normal' | 'abnormal' | 'detecting' | 'unknown'

export function deriveAnomalyStatus(input: {
  eventCount: number
  hasDetecting?: boolean
}): AnomalyStatus {
  if (input.hasDetecting) return 'detecting'
  if (input.eventCount > 0) return 'abnormal'
  // 无事件：列表侧视为 unknown（未观测到可靠性信号），不是断言 normal
  return 'unknown'
}

export function normalizeAnomalyFilter(raw: string | null | undefined): AnomalyStatus | 'all' {
  const value = String(raw || 'all').trim().toLowerCase()
  if (value === 'normal' || value === 'abnormal' || value === 'detecting' || value === 'unknown') {
    return value
  }
  return 'all'
}
