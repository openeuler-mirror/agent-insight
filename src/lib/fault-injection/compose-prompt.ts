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
 * Compose the user prompt that activates a fault skill scenario.
 * Insight task creation SoT — not mirrored in Python CLI.
 */
export function composeFaultPrompt(input: {
  skillName: string
  basePrompt: string
  submode?: { id?: string; name: string } | null
}): string {
  const skillName = String(input.skillName || '').trim()
  const instruction = input.submode?.name
    ? `使用 ${skillName} 技能，执行${input.submode.name}。`
    : `使用 ${skillName} 技能。`
  const base = String(input.basePrompt || '').trim()
  if (!base) return instruction
  if (base.includes(instruction.replace(/。$/, ''))) return base
  return `${instruction}\n\n${base}`
}

export function findSubmode(
  submodes: Array<{ id: string; name: string }>,
  submodeId: string | null | undefined,
): { id: string; name: string } | null {
  if (!submodeId) return null
  const needle = String(submodeId).trim()
  const exact = submodes.find((item) => item.id === needle || item.name === needle)
  if (exact) return exact
  const lowered = needle.toLowerCase()
  return (
    submodes.find(
      (item) => item.id.toLowerCase() === lowered || item.name.toLowerCase() === lowered,
    ) || null
  )
}
