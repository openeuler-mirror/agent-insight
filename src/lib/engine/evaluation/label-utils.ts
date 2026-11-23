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

function isAutoLabel(label: string) {
  if (!label) return false
  return label === "without-skill"
}

export function chooseExecutionLabel(args: {
  existingLabel?: string | null
  incomingLabel?: string | null
  skill?: string | null
  skillVersion?: number | null
}) {
  const incoming = typeof args.incomingLabel === "string" ? args.incomingLabel.trim() : undefined
  if (incoming !== undefined) {
    if (!incoming) return undefined
    return incoming
  }

  const existing = typeof args.existingLabel === "string" ? args.existingLabel.trim() : ""
  const skill = typeof args.skill === "string" ? args.skill.trim() : ""
  const skillVersion = args.skillVersion ?? null

  if (existing && !isAutoLabel(existing)) return existing

  if (skill) {
    const v = typeof skillVersion === "number" && Number.isFinite(skillVersion) ? skillVersion : 0
    return `${skill}-v${v}`
  }

  return "without-skill"
}

