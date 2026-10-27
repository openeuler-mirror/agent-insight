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

export type LabelSkillVersionBinding = {
  skill: string
  skill_version: number
  skills: string[]
  invokedSkills: { name: string; version: number | null }[]
}

export function parseLabelSkillVersionBinding(label: string): LabelSkillVersionBinding | null {
  const raw = typeof label === "string" ? label.trim() : ""
  if (!raw) return null
  if (raw === "without-skill") return null

  const m = raw.match(/^(.+)-v(\d+)$/)
  if (!m) return null
  const skill = (m[1] || "").trim()
  const version = Number(m[2])
  if (!skill) return null
  if (!Number.isFinite(version) || version < 0) return null

  return {
    skill,
    skill_version: version,
    skills: [skill],
    invokedSkills: [{ name: skill, version }],
  }
}
