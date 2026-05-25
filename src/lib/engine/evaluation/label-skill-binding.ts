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
