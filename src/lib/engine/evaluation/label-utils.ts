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

