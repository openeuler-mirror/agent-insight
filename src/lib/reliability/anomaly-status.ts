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
