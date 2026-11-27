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

type AnyObj = Record<string, any>

export function inferSubagentNamesFromInteractions(interactions: AnyObj[]) {
  let lastSubagentType: string | null = null
  return (interactions || []).map((m) => {
    if (!m) return m
    let setByTask = false
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const fn = tc?.function?.name || tc?.name
        if (fn !== "task") continue
        const argRaw = tc?.function?.arguments
        if (typeof argRaw !== "string") continue
        try {
          const parsed = JSON.parse(argRaw)
          const t = parsed?.subagent_type
          if (typeof t === "string" && t.trim()) {
            lastSubagentType = t.trim()
            setByTask = true
          }
        } catch {}
      }
    }

    let out = m
    if (m.role === "subagent" && !m.subagent_name && lastSubagentType) {
      out = { ...m, subagent_name: lastSubagentType }
    }
    if (m.role === "assistant" && !setByTask) lastSubagentType = null
    return out
  })
}
